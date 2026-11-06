# 棋类引擎（浏览器 WASM）

这是按需加载的引擎文件，只有点「引擎」按钮时才会下载，不影响首屏。

## Stockfish（国际象棋）

- 文件：`stockfish/stockfish.js`、`stockfish.wasm`、`stockfish.wasm.js`
- 版本：Stockfish 10 Multi-Variant（2019-08-15）
- 来源：https://github.com/nmrugg/stockfish.js
- 许可证：GPL-3.0，见 `stockfish/COPYING.txt`
- 对应源码：https://github.com/official-stockfish/Stockfish
- 用法：`B8Engine.analyze('chess', state)`，走 UCI，`go movetime 900`

## Pikafish（中国象棋）

- 文件：`pikafish/pikafish.js`、`pikafish.wasm`、`pikafish.data`、`pikafish/worker.js`
- 版本：`dev-20240226-98b20a33`
- 来源：https://github.com/ningh-o/engine-builds/releases/tag/pikafish-20240226
- 上游：https://github.com/official-pikafish/Pikafish
- 许可证：GPL-3.0；NNUE 权重见 Pikafish 项目自带声明
- 用法：`B8Engine.analyze('xiangqi', state)`，走 UCI，`go movetime 900`

## 说明

- 两个引擎都在 Web Worker 里跑，主线程不卡；
- 首次点「引擎」要下载 2–5 MB，之后浏览器缓存；
- 结果只是当前局面的引擎评估，不是整盘折线；
- 围棋/五子棋/国跳暂未接入。
