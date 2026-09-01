# 前端效能預算 SDD

## 目標

避免主畫面或延遲載入功能在未被注意的情況下膨脹，保持 2D 預設介面與可選 3D 辦公室的載入邊界。

## CI 門檻（未壓縮產物）

| Chunk | 上限 |
| --- | ---: |
| application entry | 360 KiB |
| 3D office | 220 KiB |
| Three.js | 540 KiB |
| Pixi | 620 KiB |
| rich text | 380 KiB |
| i18n catalog | 110 KiB |
| 其餘 lazy feature | 80 KiB／chunk |

`npm run check:bundle` 讀取正式 Vite 產物，超標即失敗。調整預算時必須連同此 SDD、實測理由與拆分計畫一起更新。

## 執行期

3D 場景維持既有操作 30 FPS、閒置 15 FPS 與長時間閒置凍結策略；本機診斷以 FPS 與 long task 指標提供後續調整依據。
