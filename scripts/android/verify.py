#!/usr/bin/env python3
"""
安卓产物验收（静态）。

手上没有真机也没有模拟器，所以这里能做的是**把装不上、打不开的那些原因先排除掉**：
包名/版本、ABI 与 .so 是否真的打进了 APK、前端资源有没有进 assets、
申请了哪些权限（离线写作工具不该要通讯录/定位，多一个都要说清楚为什么）。

APK 本身就是一个 zip，所以内容清单直接用 zipfile 读（比 apkanalyzer 的
`files list` 子命令好记也可靠）；只有 AndroidManifest 是二进制 XML，
得借 apkanalyzer 打印成文本再解析。

真机上才会暴露的问题（WebView 版本、软键盘、存储目录可写性）不在这里 ——
那些只能靠人装机看一眼。

用法：
    python scripts/android/verify.py [apk 路径]
"""
from __future__ import annotations

import os
import re
import subprocess
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
APK_DIR = ROOT / "release" / "android"
ANALYZER = r"F:\AI_Write_App\toolchain\android\sdk\cmdline-tools\latest\bin\apkanalyzer.bat"

CHECKS: list[tuple[str, bool, str]] = []


def check(ok: bool, label: str, detail: str = "") -> bool:
    CHECKS.append((label, ok, detail))
    print(f"  {'✓' if ok else '✗'} {label}" + (f" —— {detail}" if detail else ""))
    return ok


def manifest_text(apk: Path) -> str:
    env = dict(os.environ)
    env["JAVA_HOME"] = r"F:\AI_Write_App\toolchain\android\jdk\17"
    env["ANDROID_HOME"] = r"F:\AI_Write_App\toolchain\android\sdk"
    p = subprocess.run(
        f'"{ANALYZER}" manifest print "{apk}"', shell=True, capture_output=True, env=env
    )
    return (p.stdout or b"").decode("utf-8", "replace")


def group1(pattern: str, text: str) -> str:
    m = re.search(pattern, text)
    return m.group(1) if m else ""


def main() -> int:
    apks = sorted(APK_DIR.glob("*.apk")) if APK_DIR.exists() else []
    if len(sys.argv) > 1 and not sys.argv[1].startswith("--"):
        apks = [Path(sys.argv[1])]
    if not apks:
        print(f"没有找到 APK：{APK_DIR}")
        return 1

    for apk in apks:
        print(f"\n=== {apk.name}  ({apk.stat().st_size/1024/1024:.2f} MiB) ===")
        mf = manifest_text(apk)
        pkg = group1(r'package="([^"]+)"', mf)
        min_sdk = group1(r'minSdkVersion="([^"]+)"', mf)
        target_sdk = group1(r'targetSdkVersion="([^"]+)"', mf)
        version_name = group1(r'versionName="([^"]+)"', mf)
        version_code = group1(r'versionCode="([^"]+)"', mf)
        perms = re.findall(r'<uses-permission[^>]*android:name="([^"]+)"', mf)

        with zipfile.ZipFile(apk) as z:
            names = z.namelist()
            # .so 的实际字节数要从 zip 条目里读 —— 名字在、内容是空的，
            # 这种包照样能装，但一启动就崩。构建脚本摆产物那一步出过这个岔子
            # （建不出符号链接时留了个 0 字节空壳），所以这里必须看大小。
            so_sizes = {i.filename: i.file_size for i in z.infolist() if i.filename.endswith(".so")}
        sos = [n for n in names if n.startswith("lib/") and n.endswith(".so")]
        abis = sorted({n.split("/")[1] for n in sos})
        asset_files = [n for n in names if n.startswith("assets/")]

        check(pkg == "dev.writerbench.desktop", "包名正确", pkg or "（读不到）")
        check(bool(version_name) and bool(version_code), "有版本号", f"{version_name} ({version_code})")
        check(min_sdk.isdigit() and int(min_sdk) >= 24, "minSdk ≥ 24", min_sdk)
        check(target_sdk.isdigit() and int(target_sdk) >= 33, "targetSdk 达标", target_sdk)
        check(
            any("libwriter_lib.so" in n for n in sos),
            "Rust 动态库已打包",
            ", ".join(abis) or "没找到 .so",
        )
        # 名字在不算数：空壳 .so 的 APK 能装、能打开图标，然后立刻闪退。
        # 真库是 4 MB 级，这里留个宽松下限即可（换 ABI / 换优化等级都不会掉到 1 MB 以下）。
        main_so = next((s for n, s in so_sizes.items() if "libwriter_lib.so" in n), 0)
        check(
            main_so > 1024 * 1024,
            "Rust 动态库是有内容的（不是空壳）",
            f"libwriter_lib.so = {main_so/1024/1024:.2f} MiB",
        )
        check(
            any(n.endswith("assets/index.html") for n in asset_files),
            "前端入口在 assets 里",
            f"{len(asset_files)} 个资源文件",
        )
        check(
            any(n.startswith("assets/assets/") and n.endswith(".js") for n in asset_files),
            "前端脚本已打包",
            f"{len([n for n in asset_files if n.endswith(('.js', '.css'))])} 个 JS/CSS",
        )
        # 离线写作工具不该申请任何需要用户授权的权限：存储走应用专属目录，无需授权；
        # INTERNET 是给可选的 AI 联网用的（不配 Key 就一次也不会发）。
        extra = [p for p in perms if not p.startswith("dev.writerbench.") and p != "android.permission.INTERNET"]
        check(not extra, "没有申请多余权限", ", ".join(perms) or "（无权限声明）")

        if "--verbose" in sys.argv:
            print("\n--- manifest ---\n" + mf[:1200])
            print("\n--- 资源（前 20 个）---")
            for n in asset_files[:20]:
                print("  " + n)

    bad = [c for c in CHECKS if not c[1]]
    print(f"\n通过 {len(CHECKS) - len(bad)}/{len(CHECKS)} 项")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
