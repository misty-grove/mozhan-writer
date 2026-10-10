# 验收记录

这里是关键验收跑完后留下的**原始输出**，不是手写的总结 —— 可以直接拿来对账。

| 文件 | 哪一层 | 项数 |
|---|---|---|
| `浏览器端-164项.txt` | `npm run e2e`（真实 Chrome，走完整个用户流程） | 164 |
| `桌面端-42项.txt` | `npm run e2e:desktop`（真实 WebView2 窗口 + 真实磁盘 IPC） | 42 |
| `截图/` | 上面两层跑的时候自动截的 | 27 张 |

`截图/浏览器-*.png` 和 `截图/桌面-*.png` 前缀区分是哪一层截的。

## 这些是快照，不是标准

**判断有没有通过，跑命令为准**，不要拿这里的数字当验收标准 ——
每加一个功能项数都会涨，而且它们本来就是"当时那台机器、那个版本"的记录。

```bash
npm run verify:all        # typecheck + selfcheck + smoke + e2e（四层，缺一不可）
npm run rust:verify       # 动了 Rust 才需要
npm run e2e:desktop       # 要出安装包时跑（会自己找 release 产物）
```

截图默认写到**工程内的 `.e2e-shots/`**（已在 `.gitignore` 里），
想换位置就设环境变量 `E2E_SHOTS=<目录>`。

## 四层验收分别管什么

- **typecheck** — 类型对不对（`src/` 与 `scripts/` 一起查）
- **selfcheck** — 核心层的纯逻辑断言，宿主是内存文件系统，不联网、不要浏览器
- **smoke** — jsdom 里把每个面板/视图挂载一遍，抓渲染期报错
- **e2e** — 真 Chrome，真 File System Access API（挂在 OPFS 上），真键盘真鼠标

桌面版另起一层 `e2e:desktop`，因为换了宿主（文件操作从浏览器 API 换成 IPC → Rust），
四件事只有真窗口能证伪：应用在 WebView2 里起不起得来、IPC 参数名对不对、
Rust 路径校验在真磁盘上是否生效、**关窗守卫会不会把关窗本身弄坏**。

这四层加上 `rust:test`，就是"改坏了会不会被发现"的全部答案。
