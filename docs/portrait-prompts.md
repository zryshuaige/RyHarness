# 立绘补齐提示词

内置助理目前有橘猫 / 柴犬 / 灰狐三张立绘，管家与翻译还挂着剪影占位。
本文给出这两张的生图提示词，以及放进仓库的完整步骤。

## 为什么必须是动物立绘

内置模板的人格里写着具体动物（管家是囤松果的小松鼠、翻译是圆滚滚的小水獭）。
头像若与它对不上，用户一眼就能看出破绽——此前模板给的是 DiceBear `funEmoji` 族的
`db:mascot:owl` 之类的值，那一族的 seed 只是随机哈希，画出来是一张彩色笑脸，
「工程师」顶着紫色笑脸自称猫头鹰。这条约束现在有回归测试守着
（`apps/server/tests/seed.test.ts` 的「头像与人格里的动物对得上号」），
所以补素材之前模板只能用剪影占位，不会再退回拿无关的脸糊弄。

## 统一规格（两条都要满足）

现有三张立绘的共同规格，生成时照着来，出图才能同屏混排：

- **画幅**：1:1 正方形，主体居中，四周留约 8% 边距
- **底**：单色纯色圆底（不要渐变、不要纹理、不要投影），圆底之外是透明
- **风格**：3D 卡通渲染，皮毛有细节但不做写实光照；眼睛大、表情亲人
- **光线**：正面柔和均匀光，不要戏剧性侧光、不要轮廓光
- **禁止**：任何文字、水印、logo、道具遮挡主体、多余肢体

## 管家 · 小松鼠

```
A cute 3D cartoon squirrel character portrait, front-facing, centered.
The squirrel has warm brown fur with a cream belly, big friendly eyes, and holds
nothing in its paws — both paws are visible and empty.
Round solid pastel-blue background, flat even color, no gradient, no texture.
Soft even frontal lighting, no rim light, no dramatic shadows.
Square 1:1 composition with about 8% margin around the character,
head and ears fully inside the frame.
Style: polished 3D animated-film character render, detailed soft fur,
appealing and non-photorealistic.
No text, no watermark, no logo, no props, no extra limbs.
```

## 翻译 · 小水獭

```
A cute 3D cartoon otter character portrait, front-facing, centered.
The otter has soft brown fur with a lighter muzzle, big friendly eyes, and small
rounded ears — nothing held in its paws.
Round solid pastel-teal background, flat even color, no gradient, no texture.
Soft even frontal lighting, no rim light, no dramatic shadows.
Square 1:1 composition with about 8% margin around the character,
head fully inside the frame.
Style: polished 3D animated-film character render, detailed soft fur,
appealing and non-photorealistic.
No text, no watermark, no logo, no props, no extra limbs.
```

## 放进仓库

出图后（原始 PNG 即可，转换在下面的命令里做）：

1. 存成 `apps/desktop/src/otter.png` 与 `apps/desktop/src/squirrel.png`
   （与现有的 `cat.png` / `dog.png` / `fox.png` 同级）
2. 转成两档 WebP 并归一化成「圆形透明底」：

   ```sh
   # 圆形遮罩由 brand-portraits.ts 顶部描述的管线产出，
   # 具体命令见该文件的注释；转换后覆盖这两个文件名：
   #   apps/desktop/assets/portraits/{otter,squirrel}-{64,256}.webp
   ```

3. 在 `apps/desktop/renderer/src/lib/brand-portraits.ts` 的 `PORTRAITS` 里各加一行：

   ```ts
   { key: 'otter', label: '水獭', hint: '摆渡型：双语互译、术语对齐与语气传递' },
   { key: 'squirrel', label: '松鼠', hint: '收纳型：归档、清单与日程盘点' },
   ```

   并在 `PortraitKey` 联合类型、`FILES` 记录与四个静态 import 里补上对应键。

4. 把 `apps/server/src/seed.ts` 里管家与翻译的 `avatar: 'mask'` 换成新键，
   人设里的动物同步回写成松鼠 / 水獭。

5. 跑门禁：`npx vitest run apps/server/tests/seed.test.ts`
   （「头像与人格里的动物对得上号」会守住这两个值）。
