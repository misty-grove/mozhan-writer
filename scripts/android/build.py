#!/usr/bin/env python3
"""
安卓 APK 构建器。

为什么要单独一个脚本，而不是直接在 package.json 里写 `tauri android build`：

1. **crate-type 必须临时改**。`src-tauri/Cargo.toml` 为了桌面端刻意只留 `rlib`
   （`cdylib` 在 Windows-GNU 下链接会报 "export ordinal too large"），
   而安卓要的是动态库 —— 同一份 manifest 不能同时满足两边。
   所以只在构建期间加 `cdylib`，**无论成功失败都要改回来**（finally）。
2. **环境变量不能被 Git Bash 改写**。`JAVA_HOME` / `ANDROID_HOME` 这类 `F:\\...`
   的值经过 MSYS 传给 Windows 程序时会被改成 POSIX 路径，gradle 就看不懂了。
   所以这里用固定的工具链路径重设一遍，不依赖调用方传得对不对。

用法（Git Bash）：
    source /f/AI_Write_App/toolchain/env.sh
    python scripts/android/build.py            # 出 arm64 的 debug APK
    python scripts/android/build.py --release  # 出正式签名 APK（需要 keystore）
    python scripts/android/build.py --abi all  # 四种 ABI 全编（用于上架）
"""
from __future__ import annotations

import argparse
import os
import re
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CARGO_TOML = ROOT / "src-tauri" / "Cargo.toml"
RELEASE_DIR = ROOT / "release" / "android"

# 工具链位置（全部在工作区盘，不写 C 盘）。
# 2026-10-09 搬家：F:\AI_Write_App\toolchain → F:\AI_Write_App\toolchain
TOOLCHAIN_DIR = r"F:\AI_Write_App\toolchain"
TOOLCHAIN = {
    "JAVA_HOME": TOOLCHAIN_DIR + r"\android\jdk\17",
    "ANDROID_HOME": TOOLCHAIN_DIR + r"\android\sdk",
    "ANDROID_SDK_ROOT": TOOLCHAIN_DIR + r"\android\sdk",
    "NDK_HOME": TOOLCHAIN_DIR + r"\android\ndk\27.2.12479018",
    "ANDROID_NDK_HOME": TOOLCHAIN_DIR + r"\android\ndk\27.2.12479018",
    "GRADLE_USER_HOME": TOOLCHAIN_DIR + r"\android\gradle-home",
}

DESKTOP_CRATE_TYPE = 'crate-type = ["rlib"]'
MOBILE_CRATE_TYPE = 'crate-type = ["rlib", "cdylib"]'


def set_crate_type(mobile: bool) -> bool:
    """
    切换 `[lib]` 的 crate-type。返回**切完之后是不是处在移动端状态**。

    返回值为什么看「切完之后」而不是「我有没有动过」：
    上一次构建如果在改回来之前被打断（Ctrl+C、超时被杀、cargo 挂掉），
    Cargo.toml 就会一直停在移动端状态。再跑一次时 `set_crate_type(True)`
    其实一个字都没改 —— 按「我有没有动过」它会返回 False，finally 也就不恢复，
    于是这个文件**永远卡在移动端**。而桌面端带着 cdylib 编出来的不是想发的那一版
    （`cdylib` 在 Windows-GNU 下会因为导出序号溢出而链接失败）。
    所以恢复的责任要归「这一次构建」，不归「上一次改没改」。
    """
    text = CARGO_TOML.read_text(encoding="utf-8")
    if mobile:
        if MOBILE_CRATE_TYPE not in text:
            if DESKTOP_CRATE_TYPE not in text:
                raise SystemExit(
                    f"Cargo.toml 里找不到预期的 `{DESKTOP_CRATE_TYPE}`，"
                    "脚本不敢乱改 —— 请手工确认 [lib] 段。"
                )
            text = text.replace(DESKTOP_CRATE_TYPE, MOBILE_CRATE_TYPE, 1)
            CARGO_TOML.write_text(text, encoding="utf-8")
    else:
        if MOBILE_CRATE_TYPE in text:
            text = text.replace(MOBILE_CRATE_TYPE, DESKTOP_CRATE_TYPE, 1)
            CARGO_TOML.write_text(text, encoding="utf-8")
    # 重新读一遍，而不是信内存里的 text：这是「到底恢复成功没有」的唯一证据。
    return MOBILE_CRATE_TYPE in CARGO_TOML.read_text(encoding="utf-8")


def build_env() -> dict:
    env = dict(os.environ)
    for k, v in TOOLCHAIN.items():
        env[k] = v
    # Java 与 sdkmanager 要在 PATH 里（gradle 会去找 java）
    env["PATH"] = os.pathsep.join(
        [os.path.join(TOOLCHAIN["JAVA_HOME"], "bin"), env.get("PATH", "")]
    )
    # Git Bash 的路径改写只影响参数，这里主要是防 gradle 拿到被改写的 JAVA_HOME
    env["MSYS2_ARG_CONV_EXCL"] = "*"
    return env


def run(cmd: list[str], env: dict, cwd: Path | None = None, capture: bool = False) -> int:
    print(f"\n>>> {' '.join(cmd)}\n", flush=True)
    # shell=True：Windows 上的 npx / gradlew 都是 .cmd / .bat，直接 exec 找不到
    p = subprocess.run(
        " ".join(cmd),
        cwd=str(cwd or ROOT),
        env=env,
        shell=True,
        capture_output=capture,
    )
    if capture:
        out = (p.stdout or b"").decode("utf-8", "replace") + (p.stderr or b"").decode(
            "utf-8", "replace"
        )
        print(out[-4000:], flush=True)
        return p.returncode, out
    return p.returncode


# Rust target → Android ABI 目录 / gradle 产物里的 ABI 标记
ABI_DIR = {
    "aarch64": "arm64-v8a",
    "armv7": "armeabi-v7a",
    "i686": "x86",
    "x86_64": "x86_64",
}
ABI_TAG = {
    "aarch64": "arm64",
    "armv7": "arm",
    "i686": "x86",
    "x86_64": "x86_64",
}
# 反查表：zip 里的 `lib/<abi 目录>/` → 命名用的短标签
ABI_TAG_BY_DIR = {ABI_DIR[k]: ABI_TAG[k] for k in ABI_DIR}
RUST_TARGET = {
    "aarch64": "aarch64-linux-android",
    "armv7": "armv7-linux-androideabi",
    "i686": "i686-linux-android",
    "x86_64": "x86_64-linux-android",
}


def cargo_profile(release: bool) -> str:
    return "release" if release else "debug"


def target_dir() -> Path:
    return Path(os.environ.get("CARGO_TARGET_DIR", TOOLCHAIN_DIR + r"\target\writer-app"))


def staged_lib_problem(abis: list[str], release: bool) -> str | None:
    """
    核对 CLI 摆进 jniLibs 的 .so 是不是**真有内容**。没问题返回 None。

    为什么非要多查这一遍 —— 这是本项目最阴的一个坑：
    `tauri android build` 摆产物用的是**符号链接**，而本机没管理员、也没开开发者模式
    （改注册表会「拒绝访问」）。建不出链接时它**不报错**：退出码照样 0，
    jniLibs 下留一个 0 字节文件，gradle 把它打进 APK，于是
      「构建成功」和「APK 装得上、一启动就闪退」同时成立。

    所以**退出码不能当证据，产物字节数才能**。这个函数是那条规矩的实现。
    """
    proj = ROOT / "src-tauri" / "gen" / "android"
    for abi in abis:
        src = target_dir() / RUST_TARGET[abi] / cargo_profile(release) / "libwriter_lib.so"
        dst = proj / "app" / "src" / "main" / "jniLibs" / ABI_DIR[abi] / "libwriter_lib.so"
        if not src.exists():
            return f"cargo 产物不见了（{src}）"
        if not dst.exists():
            return f"jniLibs 里没有 {ABI_DIR[abi]} 的 .so（符号链接指向了不存在的文件）"
        want, got = src.stat().st_size, dst.stat().st_size
        if got != want:
            return (
                f"jniLibs/{ABI_DIR[abi]}/libwriter_lib.so 只有 {got} 字节，"
                f"应为 {want} 字节 —— 符号链接没建出来，CLI 留了个空壳"
            )
    return None


def apk_native(apk: Path) -> tuple[int, str]:
    """
    拆开 APK 看它的 Rust 库到底是多大、装在哪个 ABI 目录下。
    返回 (字节数, ABI 目录名)；没有就返回 (0, "")。

    为什么要拆包而不是看文件名：`--target aarch64` 出来的包**可能叫**
    `app-universal-release-unsigned.apk`（由 AGP 的 split 配置决定），
    名字里根本没有 ABI 标签；反过来，名字里有 ABI 标签的包也可能是空壳。
    文件内容才是唯一可信的口径。
    """
    with zipfile.ZipFile(apk) as z:
        for i in z.infolist():
            if i.filename.endswith("libwriter_lib.so"):
                parts = i.filename.split("/")
                return i.file_size, (parts[1] if len(parts) > 2 else "")
    return 0, ""


def stage_artifacts(abis: list[str], release: bool) -> None:
    """
    Tauri CLI 在这一步要做的事，我们自己做一遍。

    它会为每个 ABI 造一个**符号链接** `jniLibs/<abi>/libwriter_lib.so` → cargo 产物，
    好处是改一次 Rust 不用拷贝 130MB。但 Windows 上创建符号链接要么开开发者模式、
    要么有管理员 —— 这台机器两样都没有（改注册表直接"拒绝访问"）。
    于是这里改成**复制**：体积一样、gradle 一样认，只是每次多花几秒。

    顺手把前端资源放进 `app/src/main/assets`：CLI 也是在这一步做的，
    Android 那边通过 `asset://localhost/` 读它们。
    """
    profile = cargo_profile(release)
    target_dir_ = target_dir()
    proj = ROOT / "src-tauri" / "gen" / "android"

    for abi in abis:
        src = target_dir_ / RUST_TARGET[abi] / profile / "libwriter_lib.so"
        dst_dir = proj / "app" / "src" / "main" / "jniLibs" / ABI_DIR[abi]
        dst_dir.mkdir(parents=True, exist_ok=True)
        dst = dst_dir / "libwriter_lib.so"
        if not src.exists():
            raise SystemExit(f"找不到编译产物：{src}（cargo 那一步是不是没跑成功？）")
        # 先删再拷：CLI 可能在这里留了一个 0 字节文件，直接覆盖虽然也行，
        # 但要是它当时留的是个**坏符号链接**，copy2 会跟着链接写进别处 —— 先删干净更稳。
        if dst.exists() or dst.is_symlink():
            dst.unlink()
        shutil.copy2(src, dst)
        # 复制完核对大小。这条不是洁癖：`tauri android build` 用符号链接摆产物，
        # 而本机建不出符号链接时会**留下一个 0 字节的空壳**（不是报错，是静默成功）。
        # 带着空壳打包出来的 APK 装得上、一启动就崩，比构建失败难查得多。
        if dst.stat().st_size != src.stat().st_size or dst.stat().st_size == 0:
            raise SystemExit(f"摆好的 .so 大小不对：{dst} = {dst.stat().st_size}，应为 {src.stat().st_size}")
        print(f"  .so  {abi} → {dst}  ({src.stat().st_size/1024/1024:.1f} MiB)")

    assets = proj / "app" / "src" / "main" / "assets"
    dist = ROOT / "dist"
    if assets.exists():
        shutil.rmtree(assets)
    shutil.copytree(dist, assets)
    print(f"  assets ← {dist}（{len(list(assets.rglob('*')))} 个文件）")


GRADLE_BAT = TOOLCHAIN_DIR + r"\android\gradle\gradle-9.6.1\bin\gradle.bat"


def gradle_assemble(env: dict, release: bool) -> int:
    """
    用工具链里预装的那份 gradle，而不是项目的 gradlew。

    gradlew 会先去 services.gradle.org 下载发行版，那个地址在这里连不通
    （重定向到 GitHub CDN，直接 Connect timed out）。所以 gradle 也像 JDK/NDK 一样
    预装进 F:\\AI\\toolchain（版本和 gradle-wrapper.properties 保持一致）。
    """
    proj = ROOT / "src-tauri" / "gen" / "android"
    profile = "Release" if release else "Debug"
    task = f"assemble{profile}"
    gradle = GRADLE_BAT if Path(GRADLE_BAT).exists() else "gradlew.bat"

    # 跳过 gradle 的 rust 任务：它会自己再跑一遍 `npm run build` + cargo，
    # 而这两件事 tauri CLI 前面已经做完了（.so 也已经被我们复制进 jniLibs）。
    # 更重要的是它调 npm.bat 起不来 —— 它拿到的 PATH 是 Git Bash 的那套。
    # Arch 的名字就是 ABI 目录名的驼峰写法（arm64→Arm64、x86_64→X86_64），
    # 写错 gradle 会直接报 "Cannot locate excluded tasks" 而不是默默忽略。
    skip = [f"-x :app:rustBuild{a}{profile}" for a in ("Arm64", "Arm", "X86", "X86_64")]
    skip.append(f"-x :app:rustBuildUniversal{profile}")
    return run([f'"{gradle}"', task, *skip], env, cwd=proj)


KEYSTORE = ROOT / "release" / "android" / "writer-release.jks"
KEY_ALIAS = "writer"
KEY_STOREPASS = "writer2026"  # 自用签名，不是安全边界；换机器时用同一把 key 才能覆盖安装
BUILD_TOOLS = TOOLCHAIN_DIR + r"\android\sdk\build-tools\35.0.0"


def sign_apk(src: Path, dest: Path, env: dict) -> bool:
    """
    给 release APK 签名。

    gradle 在没配 signingConfig 时会产出 `*-unsigned.apk`，而**没签名的 APK 装不上**
    （Android 会直接报"应用未安装"）。所以这里自己走一遍 zipalign + apksigner。
    密钥第一次用时自动生成 —— 后续更新必须用同一把，否则手机会当成另一个应用。
    """
    if not KEYSTORE.exists():
        KEYSTORE.parent.mkdir(parents=True, exist_ok=True)
        rc = run(
            [
                "keytool",
                "-genkeypair",
                "-v",
                f'-keystore "{KEYSTORE}"',
                f"-alias {KEY_ALIAS}",
                "-keyalg RSA",
                "-keysize 2048",
                "-validity 10000",
                f"-storepass {KEY_STOREPASS}",
                f"-keypass {KEY_STOREPASS}",
                '-dname "CN=Offline Novel Writer, O=Self, C=CN"',
            ],
            env,
        )
        if rc != 0:
            return False

    aligned = dest.with_name(dest.stem + "-aligned.apk")
    if run([f'"{BUILD_TOOLS}\\zipalign.exe"', "-f", "4", f'"{src}"', f'"{aligned}"'], env) != 0:
        return False
    rc = run(
        [
            f'"{BUILD_TOOLS}\\apksigner.bat"',
            "sign",
            f'--ks "{KEYSTORE}"',
            f"--ks-key-alias {KEY_ALIAS}",
            f"--ks-pass pass:{KEY_STOREPASS}",
            f"--key-pass pass:{KEY_STOREPASS}",
            f'--out "{dest}"',
            f'"{aligned}"',
        ],
        env,
    )
    if aligned.exists():
        aligned.unlink()
    # apksigner 顺手写出的 v4 签名旁证（.idsig）：只有 `adb install --incremental` 用得上，
    # 而直接点开 APK 安装走的是 v2/v3 签名（已经签在包里了）。留着只会让 release 目录
    # 多出一个没人认识的同名文件，所以收掉。
    idsig = dest.with_name(dest.name + ".idsig")
    if idsig.exists():
        idsig.unlink()
    return rc == 0


def find_apks() -> list[Path]:
    base = ROOT / "src-tauri" / "gen" / "android" / "app" / "build" / "outputs"
    return sorted(base.rglob("*.apk"))


def local_takeover_reason(out: str) -> str | None:
    """
    判断 `tauri android build` 的**失败**是不是本机工具链的已知限制造成的。
    是就返回一句人话（进日志），不是就返回 None —— 那种情况照旧算构建失败。

    注意这个函数只管「CLI 报了错」那一半。另一半更阴：CLI **不报错**
    但 jniLibs 里是个 0 字节空壳（符号链接没建出来），那种情况退出码是 0，
    由 `staged_lib_problem()` 抓 —— 见那里的注释。

    两个限制都不是代码问题：
      1. 它给 .so 造**符号链接**，而本机没管理员、也没开开发者模式（改注册表会「拒绝访问」），
         于是要么报 "symbolic link ... not allowed"，要么更糟 —— 静默留一个 0 字节空壳；
      2. 它调项目的 `gradlew`，而 wrapper 要去 services.gradle.org 下 gradle 发行版，
         那个地址在本机连不通（所以 gradle 也像 JDK/NDK 一样预装进了 F:\\AI_Write_App\\toolchain）。

    这两条都由脚本自己接手：摆好 jniLibs/assets（见 stage_artifacts），
    再用**预装的 gradle** 打包（见 gradle_assemble）。

    接手不会掩盖真正的编译错误：兜底跑的是同一个 gradle、同一份源码，
    真是 Kotlin/Java 编译不过，兜底那一步照样失败并把错误吐出来 —— 它只绕过了下载。
    cargo 那一步挂掉也藏不住：那时 .so 根本不存在，stage_artifacts 会直接报错。
    """
    if "symbolic link" in out and "not allowed" in out:
        return "造不出 .so 符号链接（没管理员 / 没开开发者模式）"
    if re.search(r"gradlew\.bat[\s\S]{0,400}?exited with code 1", out):
        return "gradlew 这一步走不通（wrapper 要连 services.gradle.org，本机不通）"
    return None


def plan_outputs(release: bool, ver: str) -> dict[Path, tuple[Path, int, str]]:
    """
    决定「gradle 产出的这一堆 APK 里，哪几个值得发出去、各自叫什么」。

    返回 `目标路径 → (来源 APK, .so 字节数, ABI 目录名)`。

    单独抽成一个函数是为了能**不跑 16 分钟的构建就测它** ——
    挑包的规则（下面两条）恰恰是最容易写错、又最难靠肉眼复查的那一类。
    """
    # 认「里面有没有真库」，不认文件名。gradle 会为每个 ABI 都出一个 APK，
    # 没编 Rust 的那些里面没有 .so —— 装到手机上就是启动即崩的空壳，比没有更糟。
    # 而文件名同样不可信：空壳包也会叫 `...-arm64-...`，单 ABI 构建的包还可能叫
    # `app-universal-release-unsigned.apk`（名字里根本没有 ABI）。
    picked: dict[Path, tuple[Path, int, str]] = {}
    for apk in find_apks():
        so_size, so_dir = apk_native(apk)
        if so_size <= 1024 * 1024:
            print(f"  跳过（里面没有可用的 .so，{so_size} 字节）：{apk.name}")
            continue
        tag = ABI_TAG_BY_DIR.get(so_dir) or next(
            (a for a in ABI_TAG.values() if f"-{a}-" in apk.name), "universal"
        )
        dest = RELEASE_DIR / (
            f"墨栈写作台-{ver}-{tag}.apk" if release
            else f"墨栈写作台-{ver}-{tag}-debug.apk"
        )
        prev = picked.get(dest)
        if prev is not None:
            # 同一个目标被两个包认领：gradle 会同时出按 ABI 分包的 `app-arm64-...apk`
            # 和一个内容一模一样的 `app-universal-...apk`（只编了一个 ABI 时）。
            # 合在一起处理会把同一个文件签两遍，日志里出现两条「产物」，
            # 看的人会以为自己拿到了两个包。冲突时留**按 ABI 分包**的那个 ——
            # `universal` 只有在真编了多个 ABI 时才名副其实。
            if "universal" not in prev[0].name:
                print(f"  跳过（{dest.name} 已由 {prev[0].name} 产出）：{apk.name}")
                continue
            print(f"  改由更明确的 {apk.name} 产出 {dest.name}")
        picked[dest] = (apk, so_size, so_dir)
    return picked


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--abi", default="aarch64", help="aarch64 | armv7 | i686 | x86_64 | all")
    ap.add_argument("--release", action="store_true", help="出正式包（需配置签名）")
    ap.add_argument("--aab", action="store_true", help="出 AAB（上架用，默认 APK）")
    ap.add_argument("--init-only", action="store_true", help="只生成/刷新安卓工程，不构建")
    args = ap.parse_args()

    env = build_env()
    if args.init_only:
        return run(["npx", "tauri", "android", "init"], env)
    cmd = [
        "npx",
        "tauri",
        "android",
        "build",
        "--aab" if args.aab else "--apk",
    ]
    if args.abi != "all":
        cmd += ["--target", args.abi]
    if not args.release:
        cmd.append("--debug")

    abis = list(ABI_DIR.keys()) if args.abi == "all" else [args.abi]

    # 返回值是「现在是不是移动端状态」—— 是就说明恢复的责任在本次构建，见 set_crate_type。
    mobile_now = set_crate_type(True)
    rc = 1
    try:
        rc, out = run(cmd, env, capture=True)
        # 两条判废路径，缺一不可：
        #   退出码非 0 → 看是不是本机限制（是就接手，不是就真的失败）
        #   退出码为 0 → **也要查产物**，因为符号链接失败时 CLI 是静默成功的
        reason = None
        if rc != 0:
            known = local_takeover_reason(out)
            if known is None:
                return rc
            reason = f"CLI 报错：{known}"
        else:
            problem = staged_lib_problem(abis, args.release)
            if problem:
                reason = f"CLI 退出码 0，但产物是坏的：{problem}"
        if reason:
            print(f"CLI 这一步不能用（{reason}），改由脚本自己摆好产物再调预装 gradle。", flush=True)
            stage_artifacts(abis, args.release)
            rc = gradle_assemble(env, args.release)
    finally:
        if mobile_now:
            set_crate_type(False)
            print("已把 Cargo.toml 的 crate-type 恢复为桌面版", flush=True)

    if rc == 0:
        RELEASE_DIR.mkdir(parents=True, exist_ok=True)
        version = re.search(r'^version = "([^"]+)"', (ROOT / "src-tauri" / "Cargo.toml").read_text(encoding="utf-8"), re.M)
        ver = version.group(1) if version else "0.1.0"
        # 先挑包、再签名：见 plan_outputs 的注释（同一个目标可能被两个包认领）。
        for dest, (apk, so_size, so_dir) in plan_outputs(args.release, ver).items():
            if args.release:
                if not sign_apk(apk, dest, env):
                    print(f"签名失败：{apk}")
                    return 1
            else:
                shutil.copy2(apk, dest)
            print(
                f"产物：{dest}  ({dest.stat().st_size/1024/1024:.2f} MiB，"
                f"Rust 库 {so_size/1024/1024:.2f} MiB / {so_dir})"
            )
    return rc


if __name__ == "__main__":
    sys.exit(main())
