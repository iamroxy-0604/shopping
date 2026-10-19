# 拾光 A2UI 主题与组件架构图

## 当前架构

```mermaid
flowchart TD
    A[小红书 / B站 / 知乎 / 公开网页] --> B[链接转接器 resolve]
    B --> C[统一内容记录 Record]

    C --> P1[LLM Planner]
    P1 --> P2{白名单与 Schema 校验}
    P2 -->|通过| D[React A2UI Composer]
    P2 -->|超时 / 无效| P3[规则回退]
    P3 --> D
    D --> E{内容类型与数据完整度}
    E -->|preview| F[ExperiencePreview]
    E -->|video| G[VideoExperienceDetail]
    E -->|image| H[ImageExperienceDetail]
    E -->|article| I[ArticleExperienceDetail]
    E -->|unavailable| J[MediaUnavailable]

    F --> K[A2UI v0.9.1 Messages]
    G --> K
    H --> K
    I --> K
    J --> K

    K --> L[MessageProcessor]
    L --> M[拾光 Catalog]
    M --> N[React Renderer]

    O[Theme Registry] --> N
    O --> O1[暖橙编辑风]
    O --> O2[千禧数码风]
    O --> O3[未来：牛仔风]
    O --> O4[未来：手账风]

    P[MUI] --> N
    Q[Radix Dialog] --> N
    R[Embla Carousel] --> N
    S[字体 / 纹理 / 贴纸 / 图标资产] --> O

    N --> T[最终预览卡与详情弹层]
```

## 风格新增决策

```mermaid
flowchart TD
    A[新风格需求] --> B{只改视觉语言？}
    B -->|是| C[新增 Theme Token]
    C --> D[配色 / 字体 / 圆角 / 阴影 / 间距 / 动效]
    D --> E[新增纹理与装饰资产]
    E --> F[用原组件做主题回归测试]

    B -->|否，连信息结构也变| G[新增组件 variant 或业务组件]
    G --> H[扩展 Zod Schema]
    H --> I[注册到拾光 Catalog]
    I --> J[扩展 Composer 选择规则]
    J --> F
```

## 主题素材清单

| 类型 | 牛仔风 | 手账风 |
|---|---|---|
| 配色 | 牛仔蓝、革棕、米白、铆钉银 | 米白纸、墨水黑、低饱和贴纸色 |
| 字体 | 粗衬线或 slab serif，正文保持易读 | 手写字用于标题，正文使用清晰黑体 |
| 容器 | 布料边缘、缝线、皮标、金属扣 | 纸张、胶带、便签、撕边、印章 |
| 图标 | 金属线性图标 | 手绘线条图标 |
| 动效 | 沉稳、轻微压入 | 纸张弹出、贴纸观感 |
| 必需资产 | 牛仔纹理、缝线、皮标、扣件 | 纸纹、胶带、贴纸、撕边、印章 |

## 例图要求

- 技术上不强制提供例图，仅用文字也能实现主题。
- 若要稳定地还原特定风格，建议每套主题提供 3–5 张参考图：整体界面、卡片、弹层、材质细节和字体氛围。
- 参考图用来定义设计系统，不需要为每个链接或每次 A2UI 生成重新提供。
- 纹理、贴纸、胶带、布料和金属等可见资产需要使用授权素材或单独生成，不由 A2UI 消息现场绘制。

