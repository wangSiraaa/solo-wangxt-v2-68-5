# Sprite Atlas Studio

游戏美术本地序列帧 → 精灵图集工具。**纯 Web、纯本地**：所有图片处理都在浏览器内完成，不上传任何数据。

## 功能

- **多工程**：本地工程列表（新建 / 切换 / 删除），各自独立保存帧、片段、设置与打包结果
- **导入 PNG 序列帧**：文件选择或拖拽，保持导入顺序（可拖拽/按钮调整）
- **帧时长**：逐帧设置毫秒数，或一键应用到全部帧
- **动画片段（顺序引用）**：以当前帧顺序创建命名片段，帧可被多个片段引用；预览可切换播放整段序列或单个片段
- **透明边缘裁切**：按 alpha 通道计算包围盒，记录 `spriteSourceSize` 偏移
- **统一留白**：每帧四周固定像素留白（打包时把矩形放大 `padding*2` 后排布，内容居中）
- **矩形打包**：maxrects-packer，**固定方向不旋转**，图集尺寸支持 POT（2 的幂）
- **动画预览**：PixiJS 按顺序与每帧时长循环播放；从图集取子纹理并按裁切偏移摆放（等同引擎行为），实时显示当前帧在图集中的位置/尺寸
- **图集视图**：编号框标注每帧位置，表格列出 x/y/w/h、裁切偏移、原始尺寸、时长
- **工程合并**：把另一个本地工程（或导出的 JSON）合并进当前工程，详见下文
- **导出**：`atlas.png` + `atlas.json`（TexturePacker Hash 兼容结构，扩展 `duration` / `frameOrder` / `settings` / `clips` / `mergeHistory`；可内嵌图集 dataURL）
- **导入 JSON 工程**：从导出的 JSON 恢复为新本地工程——帧顺序、图集、片段与合并历史完整保留（图集内嵌时无需另选图片；否则连同 `atlas.png` 一起选择）
- **IndexedDB 持久化**：多工程 + 内容寻址图片 + 合并记录自动保存到浏览器本地，刷新后恢复

## 工程合并

「合并工程…」把**导入工程**（另一个本地工程，或导出的 JSON 文件）合并进**当前工程**：

1. **合并预览**
   - 按**像素级内容摘要**（SHA-256）识别相同帧：同名同内容自动去重，只保留一份，导入方的片段引用合并到现有帧
   - 按**名称**识别同名冲突（内容不同）
   - 列出新增帧、以及片段 / 顺序引用影响（导入片段的每个引用将指向哪帧、当前片段是否受「采用导入」影响）
   - 预检逐帧解码，损坏图片、悬空引用在确认前暴露
2. **冲突决策**：逐项选择「保留当前 / 采用导入 / 重命名导入项」（重命名可自定义名称，自动避让重名）；顶部批量规则一键应用后仍可单项覆盖
3. **原子提交**：确认后先校验全部图片、重打包图集，再在**单个 IndexedDB 事务**中写入工程 + 图片 + 合并记录——任一图片损坏、引用悬空或打包失败都完整回滚到合并前状态，不留半合并数据
4. **合并记录**：带来源摘要（工程名、帧/片段数）与全部冲突决策；记录持久化，**刷新后仍可撤销最近一次合并**（恢复快照并回收本次新增的图片）
5. **导出再导入一致**：帧顺序、图集布局、片段与冲突决策随 JSON 完整往返；由于内容摘要基于像素，重新编码的 PNG 仍能识别为相同帧

## 技术栈

Svelte 5 + TypeScript（状态与 UI）· PixiJS v8（动画预览）· maxrects-packer（矩形打包）· idb（IndexedDB）· Vite

## 开发

```bash
npm install
npm run dev        # 开发服务器
npm run build      # 构建到 dist/
npm run preview    # 预览构建产物
npm run check      # svelte-check 类型检查
```

## 测试

```bash
npm run gen-assets # 生成验证素材到 test-assets/（8 帧：不同尺寸 + 不等厚透明边缘）
npm test           # vitest：单元（裁切/打包/计时/序列化/内容摘要/合并引擎）+ 集成（真实 PNG 全管线、合并验收）
npm run e2e        # Playwright：浏览器全流程（导入→打包→预览→导出→导入恢复→刷新恢复；合并全流程）
```

集成测试（`tests/integration/`）用真实 PNG 验证：

- 裁切包围盒与生成素材的透明边缘完全一致；图集中每帧内容位置、统一留白
- 导出 JSON → 重新导入后帧列表/顺序/时长/位置尺寸完整恢复，且恢复帧与原图**逐像素一致**
- 合并验收（`merge-flow.test.ts`，fake-indexeddb 上的完整合并流程）：
  - 同名同内容只保留一份并合并引用；同名不同内容按重命名策略保留两份
  - 导入工程内部多处引用随重命名同步更新；批量规则应用后可单项覆盖
  - 故意加入损坏图片 / 悬空引用 / 打包失败 → 完整回滚，数据库零改动
  - 刷新后可撤销最近合并（栈语义）；文件来源合并撤销后新增图片被回收
  - 导出再导入后帧顺序、图集和冲突决策一致，再合并时全部识别为相同帧

## JSON 格式

```jsonc
{
  "frames": {
    "walk_01.png": {
      "frame": { "x": 2, "y": 2, "w": 42, "h": 48 },   // 图集中的位置与尺寸
      "rotated": false,                                 // 固定方向，恒为 false
      "trimmed": true,
      "spriteSourceSize": { "x": 8, "y": 10, "w": 42, "h": 48 }, // 裁切偏移
      "sourceSize": { "w": 64, "h": 64 },               // 原始尺寸
      "duration": 100                                   // 帧时长 ms
    }
  },
  "meta": {
    "app": "sprite-atlas-studio",
    "version": "1.0.0",
    "image": "atlas.png",
    "size": { "w": 256, "h": 512 },
    "frameOrder": ["walk_01.png", "..."],   // 原始播放顺序
    "settings": { "trim": true, "padding": 2, "maxSize": 2048, "pot": true },
    "totalDuration": 950,
    "atlasDataURL": "data:image/png;base64,...",  // 可选：内嵌图集，JSON 可独立恢复
    "projectName": "我的工程",                     // 可选：导入时作为新工程名
    "clips": [{ "name": "奔跑", "frames": ["walk_01.png", "..."] }], // 可选：片段（按帧名顺序引用）
    "mergeHistory": [{                            // 可选：合并历史（来源摘要与冲突决策）
      "id": "...", "ts": 1750000000000, "undone": false,
      "source": { "name": "工程B", "origin": "local", "frameCount": 8, "clipCount": 2 },
      "decisions": { "run_b.png": "rename" },
      "renames": { "run_b.png": "run_b_2.png" },
      "summary": { "identical": 3, "conflicts": 1, "added": 4, "clipsAdded": 2, "clipsRenamed": 1 }
    }]
  }
}
```
