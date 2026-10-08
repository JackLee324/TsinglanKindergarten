# 生产资源 → 目录 落位报告（V1 → V2）

> 由 `scripts/report-resource-directory-resolution.mjs` 生成 —— **只读**生产快照，
> 全程用**唯一 resolver**（`scripts/lib/resolve-legacy-directory.mjs`）。
> 判定依据是 `program + subject + sub_subject + folder_type` → 精确 code 匹配，
> **没有任何一条会回退到 Section**。

| 项 | 值 |
|---|---|
| 快照 | `.migration/prod-exports/v2-cutover-20261008.ndjson` |
| 快照来源 | zeabur，生成于 2026-10-08T03:18:23.765Z |
| 资源总数 | **347** |
| 精确落位 | **347** |
| UNRESOLVED | **0** |
| **subject-level fallback** | **0**（必须为 0） |
| 目录节点数 | 69 |

**Gate：PASS**（349/349 精确落位，0 fallback，0 unresolved）

## 每个目标目录的资源数

| V2 directory code | 资料夹 | 资源数 |
|---|---|---:|
| `prek:montessori_resource` | 教学资源 | 245 |
| `prek:montessori_lesson` | 教学详案 | 42 |
| `k:english_lesson` | 教学详案 | 38 |
| `prek:virtue_outline` | 课程大纲 | 10 |
| `prek:montessori_outline` | 课程大纲 | 6 |
| `k:english_outline` | 课程大纲 | 6 |

## 按元组统计（program / subject / sub_subject / folder_type）

| program | subject | sub_subject | folder_type | 资源数 | 精确落位 | 未解决 |
|---|---|---|---|---:|---:|---:|
| prek | montessori | culture | courseware | 98 | 98 | 0 |
| prek | montessori | practical_life | courseware | 79 | 79 | 0 |
| prek | montessori | english_language | weekly_plans | 42 | 42 | 0 |
| k | english | — | weekly_plans | 38 | 38 | 0 |
| prek | montessori | math | courseware | 36 | 36 | 0 |
| prek | montessori | sensorial | courseware | 32 | 32 | 0 |
| prek | virtue | — | curriculum_outline | 10 | 10 | 0 |
| k | english | — | curriculum_outline | 6 | 6 | 0 |
| prek | montessori | english_language | curriculum_outline | 1 | 1 | 0 |
| prek | montessori | chinese_language | curriculum_outline | 1 | 1 | 0 |
| prek | montessori | culture | curriculum_outline | 1 | 1 | 0 |
| prek | montessori | practical_life | curriculum_outline | 1 | 1 | 0 |
| prek | montessori | sensorial | curriculum_outline | 1 | 1 | 0 |
| prek | montessori | math | curriculum_outline | 1 | 1 | 0 |

## 按 program

| 值 | 资源数 |
|---|---:|
| prek | 303 |
| k | 44 |

## 按 subject

| 值 | 资源数 |
|---|---:|
| montessori | 293 |
| english | 44 |
| virtue | 10 |

## 按 sub_subject

| 值 | 资源数 |
|---|---:|
| culture | 99 |
| practical_life | 80 |
| （无） | 54 |
| english_language | 43 |
| math | 37 |
| sensorial | 33 |
| chinese_language | 1 |

## 按 folder_type

| 值 | 资源数 |
|---|---:|
| courseware | 245 |
| weekly_plans | 80 |
| curriculum_outline | 22 |

## 逐条审计（全部资源）

| # | resource id | title | program | subject | sub_subject | folder_type | V2 directory code | V2 路径 | 依据 |
|---:|---|---|---|---|---|---|---|---|---|
| 1 | `78f095f1-9022-4687-8ccb-18d2ea5dad13` | 美德 - 礼貌 主题 | prek | virtue | — | curriculum_outline | `prek:virtue_outline` | 教育教学/Pre-K/美德/课程大纲 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 2 | `6eebe304-13b5-4b28-9c08-2c3587ea9e70` | 打扰一下 | prek | montessori | practical_life | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 3 | `bdf17e77-fe15-4d15-8b0b-09e14a315818` | 使用椅子 | prek | montessori | practical_life | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 4 | `062bb693-6ed1-484e-ad3c-f610cddf273f` | 色板1 | prek | montessori | sensorial | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 5 | `7ab276db-ce56-459c-a4cd-ce762f6cb6fb` | 搬桌子 | prek | montessori | practical_life | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 6 | `ee89ca24-a214-4158-8944-015ce89b609d` | 拿尖锐物品 | prek | montessori | practical_life | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 7 | `658ad3fd-2d07-4f24-ad96-d3a2e93a0829` | 蒙特梭利 - 英文语言区工作清单 | prek | montessori | english_language | curriculum_outline | `prek:montessori_outline` | 教育教学/Pre-K/蒙特梭利/课程大纲 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 8 | `85f285d7-f3ce-4ba1-8e10-17f9de845644` | 蒙特梭利 - 中文语言区工作清单 | prek | montessori | chinese_language | curriculum_outline | `prek:montessori_outline` | 教育教学/Pre-K/蒙特梭利/课程大纲 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 9 | `1681ee77-8173-46c2-8f9a-951130f2e1a5` | 主题1：我自己 - S1 W1 | k | english | — | weekly_plans | `k:english_lesson` | 教育教学/K/英文教学/教学详案 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 10 | `05ee1c99-132c-4d83-a6de-d970691bbfe4` | 蒙特梭利 - 文化区工作清单 | prek | montessori | culture | curriculum_outline | `prek:montessori_outline` | 教育教学/Pre-K/蒙特梭利/课程大纲 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 11 | `c827369e-fa9b-435e-bc34-86bc9f36f2a9` | 主题1：我自己 - S1 W5 | k | english | — | weekly_plans | `k:english_lesson` | 教育教学/K/英文教学/教学详案 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 12 | `d806f2d3-44b5-4ebb-9fe7-c7cfdf1cbeb8` | 英文语言 - W1 - Welcome to Pre-K | prek | montessori | english_language | weekly_plans | `prek:montessori_lesson` | 教育教学/Pre-K/蒙特梭利/教学详案 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 13 | `09d06652-2281-408b-9793-13b7a0c528aa` | 英文语言 - W5 - The Food We Eat | prek | montessori | english_language | weekly_plans | `prek:montessori_lesson` | 教育教学/Pre-K/蒙特梭利/教学详案 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 14 | `6291e897-dd91-4159-984c-dde33c563f67` | 英文语言 - W16 - The World Around Us: Our Neighborhood | prek | montessori | english_language | weekly_plans | `prek:montessori_lesson` | 教育教学/Pre-K/蒙特梭利/教学详案 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 15 | `e40389f5-9224-4d96-b2bf-437575573f18` | 英文语言 - W2 - Welcome to Pre-K | prek | montessori | english_language | weekly_plans | `prek:montessori_lesson` | 教育教学/Pre-K/蒙特梭利/教学详案 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 16 | `18c20f24-9322-4339-9e76-25a4e62148d6` | 主题4：自然世界 - S1 W18 | k | english | — | weekly_plans | `k:english_lesson` | 教育教学/K/英文教学/教学详案 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 17 | `8c20b780-079b-4690-8eea-4b04ba60558d` | 美德 - 整洁 主题 | prek | virtue | — | curriculum_outline | `prek:virtue_outline` | 教育教学/Pre-K/美德/课程大纲 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 18 | `7906f565-bfbe-4fe6-98dc-37ff5823f34b` | 美德 - 感恩 主题 | prek | virtue | — | curriculum_outline | `prek:virtue_outline` | 教育教学/Pre-K/美德/课程大纲 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 19 | `251cb519-b759-4bc7-89dc-12b94b260804` | 使用工作毯 | prek | montessori | practical_life | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 20 | `78a146b4-6628-4366-90a5-6e27af89c6b5` | 美德 - 慷慨 主题 | prek | virtue | — | curriculum_outline | `prek:virtue_outline` | 教育教学/Pre-K/美德/课程大纲 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 21 | `4ac90ceb-67b5-47a0-b5af-f6e6187a93c1` | 美德 - 团结 主题 | prek | virtue | — | curriculum_outline | `prek:virtue_outline` | 教育教学/Pre-K/美德/课程大纲 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 22 | `0e8165e1-be0d-4f78-b323-c9fa5fd69394` | 美德 - 耐心 主题 | prek | virtue | — | curriculum_outline | `prek:virtue_outline` | 教育教学/Pre-K/美德/课程大纲 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 23 | `5f220275-77f9-4698-ab6b-2dfcbe0b81cc` | 美德 - 诚实 主题 | prek | virtue | — | curriculum_outline | `prek:virtue_outline` | 教育教学/Pre-K/美德/课程大纲 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 24 | `c9e90427-c11b-459b-886a-707570a8aacc` | 美德 - 服务 主题 | prek | virtue | — | curriculum_outline | `prek:virtue_outline` | 教育教学/Pre-K/美德/课程大纲 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 25 | `c028af29-8ca2-4263-bea1-3da5da09f369` | 美德 - 快乐 主题 | prek | virtue | — | curriculum_outline | `prek:virtue_outline` | 教育教学/Pre-K/美德/课程大纲 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 26 | `378d0140-59ba-472b-891d-a7db80b33896` | 美德 - 预留美德主题 主题 | prek | virtue | — | curriculum_outline | `prek:virtue_outline` | 教育教学/Pre-K/美德/课程大纲 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 27 | `c8f7ff89-c70c-4fc5-844b-a16b84236c9f` | 蒙特梭利 - 日常生活区工作清单 | prek | montessori | practical_life | curriculum_outline | `prek:montessori_outline` | 教育教学/Pre-K/蒙特梭利/课程大纲 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 28 | `8fb39e1d-89b5-49a0-b6b4-97be1b079b40` | 蒙特梭利 - 感官区工作清单 | prek | montessori | sensorial | curriculum_outline | `prek:montessori_outline` | 教育教学/Pre-K/蒙特梭利/课程大纲 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 29 | `56f36d38-0286-4010-ab0d-cb41701ab7a5` | 蒙特梭利 - 数学区工作清单 | prek | montessori | math | curriculum_outline | `prek:montessori_outline` | 教育教学/Pre-K/蒙特梭利/课程大纲 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 30 | `40cb8ab7-cefa-4ca5-95c9-1c7d0c32d37f` | 英文语言 - W3 - Welcome to Pre-K | prek | montessori | english_language | weekly_plans | `prek:montessori_lesson` | 教育教学/Pre-K/蒙特梭利/教学详案 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 31 | `dad78c4e-6bb2-4d16-8cb7-85579e535f61` | 英文语言 - W4 - Welcome to Pre-K | prek | montessori | english_language | weekly_plans | `prek:montessori_lesson` | 教育教学/Pre-K/蒙特梭利/教学详案 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 32 | `3667d358-2230-4c93-8d7f-81fb5e02c747` | 英文语言 - W5 - Welcome to Pre-K | prek | montessori | english_language | weekly_plans | `prek:montessori_lesson` | 教育教学/Pre-K/蒙特梭利/教学详案 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 33 | `8bee4da4-d5c9-4461-9ca2-8517448ba288` | 英文语言 - W6 - Welcome to Pre-K | prek | montessori | english_language | weekly_plans | `prek:montessori_lesson` | 教育教学/Pre-K/蒙特梭利/教学详案 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 34 | `010d055f-7419-4131-94d3-02a291fdd672` | 英文语言 - 假期 - Oct 1st–Oct 7th | prek | montessori | english_language | weekly_plans | `prek:montessori_lesson` | 教育教学/Pre-K/蒙特梭利/教学详案 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 35 | `2d35984d-2f02-4d4c-9862-7d12e0f12619` | 英文语言 - W14 - The World Around Us: Our Neighborhood | prek | montessori | english_language | weekly_plans | `prek:montessori_lesson` | 教育教学/Pre-K/蒙特梭利/教学详案 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 36 | `636db9ec-f32e-44d7-b726-db488a033304` | 英文语言 - W15 - The World Around Us: Our Neighborhood | prek | montessori | english_language | weekly_plans | `prek:montessori_lesson` | 教育教学/Pre-K/蒙特梭利/教学详案 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 37 | `eef2a19f-7482-4c83-a9f0-16f215951a22` | 英文语言 - W7 - The Inner World: Understanding Myself | prek | montessori | english_language | weekly_plans | `prek:montessori_lesson` | 教育教学/Pre-K/蒙特梭利/教学详案 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 38 | `ebf62313-ca1a-4370-9356-04660df1575f` | 英文语言 - W8 - The Inner World: Understanding Myself | prek | montessori | english_language | weekly_plans | `prek:montessori_lesson` | 教育教学/Pre-K/蒙特梭利/教学详案 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 39 | `968d8e91-2514-4e73-9bce-18685ac00f00` | 英文语言 - W9 - The Inner World: Understanding Myself | prek | montessori | english_language | weekly_plans | `prek:montessori_lesson` | 教育教学/Pre-K/蒙特梭利/教学详案 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 40 | `e3593f67-1f6e-4e0a-a0f8-d21b197f4522` | 英文语言 - W10 - The Inner World: Understanding Myself | prek | montessori | english_language | weekly_plans | `prek:montessori_lesson` | 教育教学/Pre-K/蒙特梭利/教学详案 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 41 | `ac166b58-dc8e-4059-8e3a-5eb99441636c` | 英文语言 - W11 - The Inner World: Understanding Myself | prek | montessori | english_language | weekly_plans | `prek:montessori_lesson` | 教育教学/Pre-K/蒙特梭利/教学详案 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 42 | `f4497b23-0460-4d47-9946-cb58796b7156` | 英文语言 - W12 - The World Around Us: Our Neighborhood | prek | montessori | english_language | weekly_plans | `prek:montessori_lesson` | 教育教学/Pre-K/蒙特梭利/教学详案 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 43 | `93ad1d6a-0b84-4f8a-872c-ffb7c06814c6` | 英文语言 - W13 - The World Around Us: Our Neighborhood | prek | montessori | english_language | weekly_plans | `prek:montessori_lesson` | 教育教学/Pre-K/蒙特梭利/教学详案 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 44 | `fd9b647a-ab86-4b3c-a5f3-1f4d27eac806` | 英文语言 - W17 - The World Around Us: Our Neighborhood | prek | montessori | english_language | weekly_plans | `prek:montessori_lesson` | 教育教学/Pre-K/蒙特梭利/教学详案 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 45 | `fea72d74-bfea-4096-9005-05b17d812e5f` | 英文语言 - 假期 - Dec 19th–Jan 4th | prek | montessori | english_language | weekly_plans | `prek:montessori_lesson` | 教育教学/Pre-K/蒙特梭利/教学详案 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 46 | `a26c7f15-61fe-4ef1-beab-b48866edb656` | 英文语言 - W18 - The World Around Us: Our Neighborhood | prek | montessori | english_language | weekly_plans | `prek:montessori_lesson` | 教育教学/Pre-K/蒙特梭利/教学详案 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 47 | `e8f08fe4-3193-41a9-a9ac-87ed382a58a2` | 英文语言 - W19 - The World Around Us: Our Neighborhood | prek | montessori | english_language | weekly_plans | `prek:montessori_lesson` | 教育教学/Pre-K/蒙特梭利/教学详案 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 48 | `579e1bba-e714-4f24-a9ad-4c9ac1a6ef9d` | 英文语言 - W20 - Spring Festival | prek | montessori | english_language | weekly_plans | `prek:montessori_lesson` | 教育教学/Pre-K/蒙特梭利/教学详案 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 49 | `d5e4c5d0-b1e2-4e20-ab5e-93f490949859` | 英文语言 - W21 - Spring Festival | prek | montessori | english_language | weekly_plans | `prek:montessori_lesson` | 教育教学/Pre-K/蒙特梭利/教学详案 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 50 | `0d9214a1-1abf-407b-a3ba-0b880d7b3ebd` | 英文语言 - 假期 - Jan 30th–Feb 16th | prek | montessori | english_language | weekly_plans | `prek:montessori_lesson` | 教育教学/Pre-K/蒙特梭利/教学详案 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 51 | `2db8aa7a-1aa6-4c70-9a7c-02bccdd76fd0` | 英文语言 - W1 | prek | montessori | english_language | weekly_plans | `prek:montessori_lesson` | 教育教学/Pre-K/蒙特梭利/教学详案 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 52 | `2c233993-8bf1-4841-924b-6253c95ef4f5` | 英文语言 - W2 | prek | montessori | english_language | weekly_plans | `prek:montessori_lesson` | 教育教学/Pre-K/蒙特梭利/教学详案 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 53 | `69284a8e-9d07-411a-b7df-859a56ea6c5d` | 英文语言 - W3 | prek | montessori | english_language | weekly_plans | `prek:montessori_lesson` | 教育教学/Pre-K/蒙特梭利/教学详案 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 54 | `01d8843e-4334-4e23-96af-6298b27da9dc` | 英文语言 - W4 | prek | montessori | english_language | weekly_plans | `prek:montessori_lesson` | 教育教学/Pre-K/蒙特梭利/教学详案 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 55 | `85b6c48c-5917-4dc8-a709-e5f59d9735b8` | 英文语言 - W6 - The Food We Eat | prek | montessori | english_language | weekly_plans | `prek:montessori_lesson` | 教育教学/Pre-K/蒙特梭利/教学详案 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 56 | `755f691c-fab5-4e3a-9d4b-4d4361b88e30` | 英文语言 - W7 - The Food We Eat | prek | montessori | english_language | weekly_plans | `prek:montessori_lesson` | 教育教学/Pre-K/蒙特梭利/教学详案 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 57 | `2e340feb-ef18-46f0-8788-3bd7af32ca08` | 英文语言 - W8 - The Natural World: Understanding Nature | prek | montessori | english_language | weekly_plans | `prek:montessori_lesson` | 教育教学/Pre-K/蒙特梭利/教学详案 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 58 | `f1214e6c-cc07-4983-a62b-ddafae0006da` | 英文语言 - W9 - The Natural World: Understanding Nature | prek | montessori | english_language | weekly_plans | `prek:montessori_lesson` | 教育教学/Pre-K/蒙特梭利/教学详案 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 59 | `c684f980-800e-46e3-af6c-68fbbee70927` | 英文语言 - W10 | prek | montessori | english_language | weekly_plans | `prek:montessori_lesson` | 教育教学/Pre-K/蒙特梭利/教学详案 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 60 | `cdbeaa40-cb1a-4885-8ba7-00173ee7bfba` | 英文语言 - W11 | prek | montessori | english_language | weekly_plans | `prek:montessori_lesson` | 教育教学/Pre-K/蒙特梭利/教学详案 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 61 | `e5cf3278-0bd1-4928-8fc1-ae0f390013af` | 英文语言 - W12 | prek | montessori | english_language | weekly_plans | `prek:montessori_lesson` | 教育教学/Pre-K/蒙特梭利/教学详案 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 62 | `cbd6dbb9-211e-4d25-bbab-798d81040f46` | 英文语言 - W13 | prek | montessori | english_language | weekly_plans | `prek:montessori_lesson` | 教育教学/Pre-K/蒙特梭利/教学详案 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 63 | `8b3c1f7c-31b0-4b03-9da7-a9d5ce883657` | 英文语言 - W14 | prek | montessori | english_language | weekly_plans | `prek:montessori_lesson` | 教育教学/Pre-K/蒙特梭利/教学详案 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 64 | `7e70e335-09ee-4fb0-be5b-f9b6cd244fdf` | 英文语言 - W15 - The Wider World: Our Planet | prek | montessori | english_language | weekly_plans | `prek:montessori_lesson` | 教育教学/Pre-K/蒙特梭利/教学详案 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 65 | `1b76e143-dedb-4262-86fe-62a8ed00226c` | 英文语言 - W16 - The Wider World: Our Planet | prek | montessori | english_language | weekly_plans | `prek:montessori_lesson` | 教育教学/Pre-K/蒙特梭利/教学详案 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 66 | `c449a886-2c9e-4138-b9c2-2e7fa10d9f95` | 英文语言 - W17 - The Wider World: Our Planet | prek | montessori | english_language | weekly_plans | `prek:montessori_lesson` | 教育教学/Pre-K/蒙特梭利/教学详案 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 67 | `9b9f4f2d-689d-46da-bd59-4146cbeb6b45` | 英文语言 - W18 - The Wider World: Our Planet | prek | montessori | english_language | weekly_plans | `prek:montessori_lesson` | 教育教学/Pre-K/蒙特梭利/教学详案 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 68 | `96317a6e-b1d2-43d5-84eb-88a66651cf10` | 寻求关注 | prek | montessori | practical_life | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 69 | `b93789e8-4007-4199-aad9-68d43353a07e` | 观察工作 | prek | montessori | practical_life | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 70 | `6beb7bde-5dc7-4173-b109-acd746adb539` | 请求 / 给予帮助 | prek | montessori | practical_life | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 71 | `015f92ba-a2e2-4e5b-bfcf-9f44e6e5348c` | 请和谢谢 | prek | montessori | practical_life | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 72 | `35660424-5b83-47d3-b273-7f55cf7ed6c6` | 问候和告别 | prek | montessori | practical_life | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 73 | `9293c1d5-82a4-44b1-800c-2dce926766d0` | 轻缓行走 | prek | montessori | practical_life | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 74 | `5c27d2c5-6c75-406e-aa96-c1a6bc01ddc4` | 走线 | prek | montessori | practical_life | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 75 | `22f29fb5-d1de-4c58-a6ee-421a87285d39` | 坐在线上 | prek | montessori | practical_life | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 76 | `fa8bcdb9-923d-45ae-927e-34e06a806767` | 开关门 | prek | montessori | practical_life | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 77 | `b76277d6-fe0e-40b9-a6f4-66d60f76cf7e` | 拿取托盘 | prek | montessori | practical_life | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 78 | `f96b19cc-a686-424b-97b2-44ca6b81fca9` | 捧 | prek | montessori | practical_life | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 79 | `e58e7890-a6e2-43dc-8288-8ed008d9d7c8` | 五指抓 | prek | montessori | practical_life | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 80 | `a6ca611a-ec60-49c7-9e9e-45acd40e32c8` | 开关 | prek | montessori | practical_life | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 81 | `7449a315-1f19-491c-b956-e8032b4b9baf` | 倒干物 | prek | montessori | practical_life | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 82 | `10240a02-5539-43e7-9d89-48527e4d80e7` | 使用海绵 | prek | montessori | practical_life | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 83 | `77409540-b91e-402a-aee8-1dbcc16fc892` | 倒液体 | prek | montessori | practical_life | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 84 | `fbaf5fa8-91fd-46bc-9d75-2a28082f3a3a` | 舀干物 | prek | montessori | practical_life | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 85 | `3a50c19e-4e59-4259-9158-285ed36d5c95` | 使用夹子 | prek | montessori | practical_life | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 86 | `b7de7318-192a-46c1-ae19-55faefaa245d` | 使用衣夹 | prek | montessori | practical_life | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 87 | `1be9c0cc-7630-40d8-9a19-9dd3129f1fb1` | 捞 | prek | montessori | practical_life | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 88 | `27c30840-31c1-4ab9-b313-b4c457d7bb04` | 滴管 | prek | montessori | practical_life | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 89 | `21718ec9-4e8c-4ce7-9e1b-a3d5b11eb150` | 拧螺丝 | prek | montessori | practical_life | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 90 | `02e4cd93-e00e-497c-83cd-ff0a9b420299` | 使用螺丝刀 | prek | montessori | practical_life | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 91 | `6bddbdac-3d37-4a6d-9c5f-b7390f28cb5c` | 开锁 | prek | montessori | practical_life | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 92 | `03e8bfc7-88a4-4d89-a82b-38c765ee7f51` | 搅拌 | prek | montessori | practical_life | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 93 | `8cb358ab-948e-4f0f-9b17-50d7115015f4` | 叠 | prek | montessori | practical_life | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 94 | `45cc6da1-8349-40bb-9e5d-672b80b68b9e` | 剪毛线 | prek | montessori | practical_life | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 95 | `e1bf834e-f8f0-4e9e-acdd-782f96a2b9a7` | 打结 | prek | montessori | practical_life | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 96 | `6edd0f4c-3486-4bac-9a8f-68764034409a` | 穿珠子 | prek | montessori | practical_life | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 97 | `038b2a91-c75b-4e45-b2d3-7a01490a2598` | 穿卡片 | prek | montessori | practical_life | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 98 | `e2001ad3-7ee7-4dc6-9774-eb37bdd67f18` | 穿针引线 | prek | montessori | practical_life | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 99 | `dff68c18-7f6b-4211-9f17-9bc0ce5a5087` | 缝扣子 | prek | montessori | practical_life | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 100 | `63c2b92f-92a8-4d42-b87d-8504dabb9e99` | 橡皮泥 | prek | montessori | practical_life | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 101 | `3875881b-e7c7-4ab9-aad2-485aea0eb7bc` | 蜡笔的使用（马克笔，铅笔） | prek | montessori | practical_life | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 102 | `236cf087-14c5-4947-91b8-e45842d1ee9b` | 压花 | prek | montessori | practical_life | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 103 | `e98e16d5-ae6e-48ef-b4f9-b8075f0df9f7` | 剪纸 | prek | montessori | practical_life | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 104 | `4f7906a2-12d9-4436-81e1-1d3474172fe0` | 蓝色三角形盒 | prek | montessori | sensorial | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 105 | `a1e6f9f0-f148-4cfe-9030-f50045ab1621` | 订书机 | prek | montessori | practical_life | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 106 | `f230d104-62c0-463b-ae48-31d7ed40f522` | 粘贴 | prek | montessori | practical_life | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 107 | `ac401184-9b37-4e72-8b88-74ed23fa6d32` | 折纸 | prek | montessori | practical_life | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 108 | `96fe1007-0ebb-486d-9a75-cea62fc70d43` | 刺工 | prek | montessori | practical_life | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 109 | `dd6138b4-f519-4e1d-ab19-0fd3ab3cfc5c` | 编织 | prek | montessori | practical_life | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 110 | `889f30ec-a5d6-4450-8a06-30d63340999b` | 除尘 | prek | montessori | practical_life | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 111 | `9e389b0f-815c-4f6b-9fe5-fe8c58e1f376` | 扫 | prek | montessori | practical_life | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 112 | `fe464a98-99e1-4c43-9a32-487cbdf80d59` | 拖地 | prek | montessori | practical_life | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 113 | `31d94c46-6396-4102-9651-ff73e9a294a8` | 擦桌子 | prek | montessori | practical_life | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 114 | `58a2aa8a-7bed-496c-9b79-d45e316e2e6d` | 刷工作毯 | prek | montessori | practical_life | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 115 | `caf5c3f4-5b19-47a1-9f1c-6edcfe48bf4c` | 刮玻璃 | prek | montessori | practical_life | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 116 | `f4f9e257-48b8-4b37-965e-4426a1136b67` | 抛光 | prek | montessori | practical_life | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 117 | `cfbe0b33-122c-44a8-b94c-b2dc8c83070e` | 清洁植物 | prek | montessori | practical_life | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 118 | `bf4b64fa-a4ab-4ee3-b740-5b715c9cf648` | 给植物浇水 | prek | montessori | practical_life | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 119 | `52816a48-0d2b-4dcf-b4ba-bc6f14f6141d` | 插花 | prek | montessori | practical_life | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 120 | `d4d65b93-d365-4301-82cd-d780c2b20d56` | 削铅笔 | prek | montessori | practical_life | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 121 | `928edaa0-ad73-48ea-b5d2-f771a54d0c32` | 布置桌子 | prek | montessori | practical_life | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 122 | `72d0ff1c-338d-4ccb-a2df-cd13ed58929e` | 照顾动物 | prek | montessori | practical_life | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 123 | `9ae4a2c5-9d51-417c-9e67-d60f65bb3d88` | 咳嗽 | prek | montessori | practical_life | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 124 | `2c76a164-be2a-4341-9595-fbf9b9de2e8f` | 擤鼻涕 | prek | montessori | practical_life | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 125 | `14a0105c-69f1-4113-af55-a468872da33c` | 换鞋 | prek | montessori | practical_life | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 126 | `e321f3f7-166d-4c24-9679-ae9c199d7bfd` | 使用卫生间 | prek | montessori | practical_life | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 127 | `4f64193d-a18c-4b93-adae-91d9ca843e72` | 洗手 | prek | montessori | practical_life | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 128 | `81e1dcb0-2521-4b4a-baaf-b1c1e4a69fea` | 叠外套 | prek | montessori | practical_life | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 129 | `701c3fb5-1899-4dcc-b42d-03d24d99f017` | 拉链衣饰框 | prek | montessori | practical_life | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 130 | `399d9f03-62fd-4e10-8e60-2df6b02f4a05` | 纽扣衣饰框 | prek | montessori | practical_life | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 131 | `e747a827-9347-41b4-bfb6-7533e7790fed` | 按扣衣饰框 | prek | montessori | practical_life | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 132 | `afb10f3d-6fdf-455d-a58d-9fa182adec42` | 挂扣衣饰框 | prek | montessori | practical_life | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 133 | `a9f890fa-a961-4213-8460-b2f1c93bbed4` | 纺锤棒箱 | prek | montessori | math | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 134 | `72c12628-6126-4c5d-9f66-acbcf224d882` | 皮带扣衣饰框 | prek | montessori | practical_life | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 135 | `97df5b38-b62a-4030-9be3-6086004ae2bc` | 蝴蝶结衣饰框 | prek | montessori | practical_life | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 136 | `ccbd939c-714c-47a8-b04d-28624ee05566` | 鞋带衣饰框 | prek | montessori | practical_life | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 137 | `c8a9848d-9352-441a-87b6-a7b4efdbf7ce` | 安全别针衣饰框 | prek | montessori | practical_life | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 138 | `36ef6684-a064-4f6a-84fe-67b66461ec24` | 切香蕉 | prek | montessori | practical_life | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 139 | `19e50699-b9ec-4d28-b727-6ca795d0dd9f` | 榨橙汁 | prek | montessori | practical_life | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 140 | `0d24d9e4-e615-4c9f-ba20-350e49d689b6` | 涂抹面包 | prek | montessori | practical_life | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 141 | `da930897-3ce3-4405-b8b8-58d3f0e87e5c` | 剥鸡蛋（蒜、橘子、石榴） | prek | montessori | practical_life | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 142 | `cb4d8986-49ef-43c1-8b99-95864bae77f2` | 泡茶 | prek | montessori | practical_life | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 143 | `4ae8542b-0490-4be8-9425-c725e889b5c2` | 照顾动物（如何人道地喂养动物，如小鸟投食器） | prek | montessori | practical_life | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 144 | `34947067-c09b-4648-ac9a-928f1d77e130` | 插座圆柱体 | prek | montessori | sensorial | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 145 | `8a86f051-7ca4-4ad2-b293-251af92be170` | 粉红塔 | prek | montessori | sensorial | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 146 | `73091baa-9c0d-4316-917c-3ed2a41ea808` | 棕色梯 | prek | montessori | sensorial | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 147 | `b2f47963-8f6f-4b96-8ae2-7b0efe0d8102` | 红棒 | prek | montessori | sensorial | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 148 | `560a9bc5-385a-4961-8720-54978d4720c0` | 彩色圆柱体 | prek | montessori | sensorial | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 149 | `48265a01-c784-4892-ab55-0fdffab37616` | 色板2 | prek | montessori | sensorial | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 150 | `56ee286f-cebb-47c7-8ebf-3feb4e8ab24f` | 色板2 | prek | montessori | sensorial | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 151 | `cc4627c4-b491-4e8a-8b9f-0aa4e4f4ef7a` | 几何立体组 | prek | montessori | sensorial | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 152 | `7308e767-e321-4bdd-a0df-6c953301b8b6` | 几何立体组与投影板 | prek | montessori | sensorial | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 153 | `70146cc5-5225-4719-b678-4ec287fef04a` | 立体几何神秘袋 | prek | montessori | sensorial | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 154 | `ac3cc2e6-cf14-4297-909b-c819d1e10e16` | 几何图橱 | prek | montessori | sensorial | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 155 | `c7c54a5e-e4ec-4e99-9824-b355f32a370f` | 几何图橱和对应卡 | prek | montessori | sensorial | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 156 | `ea0d1a3d-a13f-4616-8f4f-e1ebf02d53d7` | 长方形盒1 | prek | montessori | sensorial | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 157 | `ef5047de-4dc3-42ad-bc06-71f32d01c971` | 长方形盒2/蓝色三角形盒 | prek | montessori | sensorial | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 158 | `e9596b18-7c81-46c5-9a97-2e2634cf9f4a` | 三角形盒 | prek | montessori | sensorial | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 159 | `5515965b-2df5-4c9f-be1d-bd88a659a72b` | 大六边形盒 | prek | montessori | sensorial | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 160 | `7e5f40e9-2ecf-4b4a-b7db-5539772a1564` | 小六边形盒 | prek | montessori | sensorial | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 161 | `7147d3cc-ac6f-40fb-8c2d-0d6c83310e23` | 二项式 | prek | montessori | sensorial | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 162 | `405b0707-15f9-4080-a8c7-b8e793125d70` | 三项式 | prek | montessori | sensorial | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 163 | `f3266e19-2dee-47be-98e0-cb8f325a2ad1` | 听音筒 | prek | montessori | sensorial | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 164 | `b385e72f-5eb0-4145-8b67-6136cec2384c` | 音感钟 | prek | montessori | sensorial | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 165 | `cb2cf96f-3d0a-4016-b6fb-f5666df57ebb` | 触觉板（一） | prek | montessori | sensorial | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 166 | `36823a85-9843-4d51-91d9-e198d3601ceb` | 触觉板（二） | prek | montessori | sensorial | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 167 | `e5a290b5-8d99-41d6-a786-677f60f3c202` | 触觉配对板 | prek | montessori | sensorial | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 168 | `602db725-8210-432e-906b-c18965fb07f7` | 布盒 | prek | montessori | sensorial | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 169 | `38e9d40b-1fbf-4564-8416-41a42b9146b3` | 重量板 | prek | montessori | sensorial | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 170 | `f1a10dea-f36a-4cad-964b-a89f310db4fe` | 温觉板 | prek | montessori | sensorial | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 171 | `58ce7419-6902-4a6b-b7f6-d6e9b4947135` | 温觉瓶 | prek | montessori | sensorial | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 172 | `3563d4ce-3073-4087-bb21-4ccd317ffc1f` | 嗅觉瓶 | prek | montessori | sensorial | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 173 | `54936aa7-9d0c-4f5e-b0b5-a89eac3d39a3` | 味觉瓶 | prek | montessori | sensorial | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 174 | `3ed72604-207a-41d9-ba11-da9f7cd512b2` | 数棒 | prek | montessori | math | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 175 | `e8655131-8ee9-444c-8f77-cd73f30eccc9` | 砂纸数字板 | prek | montessori | math | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 176 | `27f83d02-8f31-4b9d-846a-aad9142f0c9f` | 数棒与数字卡 | prek | montessori | math | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 177 | `04ad0763-d61e-41ea-aad9-d66a242ffa13` | 数字记忆游戏 | prek | montessori | math | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 178 | `26953159-e086-4791-801d-34ff8abfbbe1` | 数字与筹码 | prek | montessori | math | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 179 | `5ae57b33-c0a7-4c59-b1c0-de28e60e2e91` | 彩色串珠 | prek | montessori | math | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 180 | `71650e82-1f8a-40bf-9061-57d2ae0549f5` | 塞根板1-串珠 | prek | montessori | math | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 181 | `be715d20-950d-4444-b293-06d0296bc328` | 塞根板1-数字卡 | prek | montessori | math | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 182 | `8d70d5e5-8ebd-4d43-b0dc-72149c60c94f` | 塞根板1-对应 | prek | montessori | math | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 183 | `b2a526e8-e91f-40a3-9e75-3bb4bdc88490` | 塞根板2 | prek | montessori | math | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 184 | `54b6c28c-f470-427f-a603-916f6e21af4e` | 十的平方链 | prek | montessori | math | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 185 | `b62406a1-391c-48a8-b3d2-eff9f379b507` | 一百板 | prek | montessori | math | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 186 | `f5c4f55c-965d-4eaf-b65c-307222b1aa7b` | 龟生长周期 | prek | montessori | culture | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 187 | `5931ee43-fdfa-4d34-bf0c-a222ff606a1c` | 1-9的平方链 | prek | montessori | math | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 188 | `757d9af1-376e-4283-adc9-e0de27d44b4e` | 十的立方链 | prek | montessori | math | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 189 | `27cae44c-4100-4f9f-89a1-9316cdd7ff6c` | 1-5的立方链 | prek | montessori | math | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 190 | `f43bd8e5-488d-4405-ae41-ec55abcb71d2` | 十进制介绍-串珠 | prek | montessori | math | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 191 | `f85ef2be-68ca-43d7-830e-a3067380f1c0` | 十进制介绍-卡片符号 | prek | montessori | math | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 192 | `ddd1df21-5c91-4c9d-ae31-6dd3c71ef1af` | 十进制数量与数字卡的对应 | prek | montessori | math | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 193 | `0d833a40-f90d-4a0a-8656-e6b91896e49b` | “9”的托盘或交换游戏 | prek | montessori | math | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 194 | `d1d5428f-aea3-4f1f-8acc-65520490f52b` | 1999的数量 | prek | montessori | math | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 195 | `7a0111ba-1ef1-4f85-9631-253ac87540f2` | 1999的数字卡 | prek | montessori | math | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 196 | `5042e8a6-540f-4b75-8c49-5d08b01dceac` | 1999数与量的对应 | prek | montessori | math | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 197 | `d6478483-47be-4cb7-bb02-b9a7fafed1dc` | 45的排列-数量 | prek | montessori | math | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 198 | `01bda93e-5ef0-469f-93db-02ba75b3e9bd` | 45的排列-数字卡片 | prek | montessori | math | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 199 | `796623bb-48b3-4f94-80fc-4da239bd47a2` | 45的排列-数量与数字卡片结合 | prek | montessori | math | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 200 | `6defb7b6-e2ce-43c2-819e-d043a0fa060a` | 四位数的组合（数字卡片） | prek | montessori | math | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 201 | `f9f67fb6-1d3c-47f5-b765-825c64978121` | 四位数的组合（数量与数卡） | prek | montessori | math | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 202 | `1aebf7b5-6ac2-4f3e-ad32-3e0fd020f82d` | 交换游戏 | prek | montessori | math | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 203 | `289c480c-8239-43f5-b775-be0a548aa3e9` | 四则运算：无进位加法 | prek | montessori | math | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 204 | `3d3070dc-ab66-42c5-8c3e-3013bf287974` | 四则运算：进位加法 | prek | montessori | math | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 205 | `b8aab1ce-9c32-499c-ae34-476cf542f3f9` | 四则运算：减法（无借位） | prek | montessori | math | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 206 | `29f1e336-c18b-4ce6-845c-b3bfa46f9b2f` | 蛇形游戏十的组合 | prek | montessori | math | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 207 | `88021cd8-1f75-4711-8571-84cf7d823a7d` | 加法蛇形游戏 | prek | montessori | math | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 208 | `1988982c-9595-4cb1-9fe5-53ccf49c2898` | 加法板 | prek | montessori | math | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 209 | `3c3472c9-1655-4039-8ab9-2f6550fca7c3` | 减法板 | prek | montessori | math | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 210 | `f9adb2a3-7855-41aa-912d-8b3e36cfbf7a` | 自然体验/自然角 | prek | montessori | culture | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 211 | `713bff21-3ec5-41e6-b17f-396c75e7823a` | 有生命与无生命 | prek | montessori | culture | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 212 | `685e658d-098a-4b50-8811-2c6b46161aba` | 植物与动物的分类 | prek | montessori | culture | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 213 | `e532071c-7e54-4908-b23b-e534d02af64e` | 认识植物的部分/认识植物 | prek | montessori | culture | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 214 | `70757932-855d-4eaf-9d9d-65ba90d2a986` | 树的嵌板 | prek | montessori | culture | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 215 | `77dea700-eb20-45a0-a998-fe810a8cb5ad` | 树的三段卡 | prek | montessori | culture | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 216 | `ecd0ef70-e618-40f7-a035-4f299d722a1e` | 树的定义小书 | prek | montessori | culture | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 217 | `c91628ac-5bcf-47a3-8b2e-1aae0be11c6d` | 叶的解剖 | prek | montessori | culture | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 218 | `106e835f-8a9d-4673-8097-d55125aab16d` | 叶的嵌板 | prek | montessori | culture | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 219 | `a67921ca-b704-4218-ab88-4dbf7efc7a0e` | 叶的三段卡 | prek | montessori | culture | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 220 | `3ae5b0ee-cb3d-4bdc-bc13-c899ade7093a` | 叶的定义小书 | prek | montessori | culture | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 221 | `67976e08-0228-464e-943d-828995369213` | 鸟的定义小书 | prek | montessori | culture | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 222 | `d1e0c6a6-9f7a-4326-ba81-21301a32b71a` | 叶形橱 | prek | montessori | culture | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 223 | `1b155e4c-04f8-44cf-91a1-3b591b7c9b53` | 花的解剖 | prek | montessori | culture | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 224 | `1dbae569-c9f7-405d-ab8c-28708b27b911` | 花的嵌板 | prek | montessori | culture | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 225 | `023e3756-5bdd-4e46-9d5f-1b6d8ab34747` | 花的三段卡 | prek | montessori | culture | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 226 | `8edeb8cb-13dc-490a-a9ba-bb4f4f8c58c2` | 花的定义小书 | prek | montessori | culture | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 227 | `309b1adc-700f-4f5b-a76b-ce535c034fbb` | 三文鱼（鱼）生长周期 | prek | montessori | culture | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 228 | `8c1604c8-96cc-4027-b8cf-3027ce5be7e5` | 植物的生长过程 | prek | montessori | culture | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 229 | `1838ee66-2b8e-4788-bfb5-751482d93036` | 植物的生长周期 | prek | montessori | culture | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 230 | `8b646e52-bebb-4c1b-b218-89d2d676cf89` | 我们吃的是植物的什么 | prek | montessori | culture | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 231 | `7e13c1f2-f466-4773-a505-7d5423cfb26a` | 观察动物 | prek | montessori | culture | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 232 | `31f88de7-8b1a-4414-aaea-acf63cabab75` | 有生命无生命 | prek | montessori | culture | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 233 | `8cb02a87-366f-4f59-819e-00afee1986fe` | 动物植物分类 | prek | montessori | culture | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 234 | `a885b78e-9fab-4f68-8e17-08234726d906` | 有脊椎无脊椎分类 | prek | montessori | culture | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 235 | `4ef80012-31d0-4b6d-82fa-def0a0d6468a` | 有脊椎五大类 | prek | montessori | culture | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 236 | `5d875f61-1036-4178-a67c-ecd752143c3b` | 哺乳动物 | prek | montessori | culture | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 237 | `bc12bf9c-51a2-475c-b08a-8604068f953f` | 马的嵌板 | prek | montessori | culture | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 238 | `0cc68a96-6556-448a-9c12-4cc5e1d4609e` | 马的三段卡 | prek | montessori | culture | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 239 | `ee0f7625-d474-4baa-853f-a407e701fe6b` | 马的定义小书 | prek | montessori | culture | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 240 | `46a6a351-d291-4c97-9d21-a5fd4569b3ca` | 鸟类模型 | prek | montessori | culture | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 241 | `b35ad374-3bae-49f6-b5ec-dc223e2dbc1a` | 鸟的嵌板 | prek | montessori | culture | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 242 | `9a74794e-6586-4f42-944e-006731c61e51` | 鸟的三段卡 | prek | montessori | culture | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 243 | `61e74bf1-4a81-47ef-8ca3-84008af48907` | 固体的重量 | prek | montessori | culture | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 244 | `5d3c0b80-39a1-4dbc-ad93-e91ef237d120` | 鱼类模型 | prek | montessori | culture | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 245 | `3e8a4adb-4264-451b-a1c4-0e30a9fa596b` | 鱼的嵌板 | prek | montessori | culture | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 246 | `b02df531-4f24-4877-9635-85979c18cca1` | 鱼的三段卡 | prek | montessori | culture | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 247 | `c1b0cbc5-abb6-451e-9ebe-d263a965a1dd` | 鱼的定义小书 | prek | montessori | culture | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 248 | `c442b005-b97d-47c6-91a1-ac3496a1c542` | 两栖动物模型 | prek | montessori | culture | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 249 | `dbc3b01e-42bb-4a15-81fc-7665f60051e6` | 青蛙的嵌板 | prek | montessori | culture | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 250 | `571a5ee7-cd67-4897-a69f-5b6f6733fece` | 青蛙的三段卡 | prek | montessori | culture | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 251 | `7295a999-d32a-462b-a2e9-b643c0ae233d` | 青蛙的定义小书 | prek | montessori | culture | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 252 | `95a007b3-3ec6-4551-82ed-a64a3fb908c3` | 爬行动物模型 | prek | montessori | culture | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 253 | `b30e392b-0896-48c1-93c0-6703941ab928` | 龟的嵌板 | prek | montessori | culture | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 254 | `588ba65e-cba6-4013-92e2-e0761f3d650f` | 龟的三段卡 | prek | montessori | culture | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 255 | `45a6c64c-4d18-45ab-9c17-8b550479914c` | 龟的定义小书 | prek | montessori | culture | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 256 | `a12a5aba-081f-499e-b2a6-e9327fab84fd` | 鸡（鸟类）生长周期 | prek | montessori | culture | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 257 | `23dac1b5-366d-4996-bcb9-388ee8df1eeb` | 青蛙生长周期 | prek | montessori | culture | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 258 | `92ba3209-14af-4be6-96a5-65d3cefcaeff` | 自选哺乳动物（牛） | prek | montessori | culture | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 259 | `6395e2a1-8d9c-4687-8a7d-ac436321a119` | 蝴蝶的嵌板 | prek | montessori | culture | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 260 | `6cab6aa0-58c9-452d-b2ef-ec4faea4a338` | 蝴蝶的三段卡 | prek | montessori | culture | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 261 | `cf6dc811-b9a8-4e33-a815-c12b2696db14` | 蝴蝶的定义小书 | prek | montessori | culture | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 262 | `3bae48b9-cd51-4b71-86a9-73eeef3c0976` | 蝴蝶生长周期 | prek | montessori | culture | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 263 | `520c39ab-6f64-45ba-95ce-f7bdab1b7ae1` | 砂纸地球仪 | prek | montessori | culture | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 264 | `e9e02a11-d4da-4fac-b4a3-0a1088229dd7` | 沉与浮 | prek | montessori | culture | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 265 | `081d507e-46fa-4a54-bc8a-76117e5b6ed6` | 土壤空气和水 | prek | montessori | culture | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 266 | `2136ed8b-00a4-43ba-8c13-a05f7ff317f3` | 彩色地球仪 | prek | montessori | culture | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 267 | `3d6d4d20-7ddc-4b9b-810d-d52f457b13fe` | 世界地图拼图的介绍 | prek | montessori | culture | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 268 | `3e1423bd-edba-4173-853f-c4ba7ba38ee6` | 各个大洲上的动物 | prek | montessori | culture | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 269 | `d444dd0c-2901-4096-bd36-19bb4ad34755` | 水陆地形盒 | prek | montessori | culture | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 270 | `98ec1b63-2c73-4479-958d-2ac5dae6b130` | 水陆地形盒三段卡 | prek | montessori | culture | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 271 | `78191492-a953-48c0-a443-29c213538f2b` | 水陆地形盒定义小书 | prek | montessori | culture | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 272 | `705d174b-3519-49c2-aa8c-831170dfad25` | 大洲地理拼图--亚洲 | prek | montessori | culture | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 273 | `25c97fd8-81e7-41a2-b6e7-7ea41dc40dd1` | 大洲文化盒--亚洲 | prek | montessori | culture | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 274 | `09fc2bb4-cb6b-487a-a4e4-3f15229ebb9b` | 影子 | prek | montessori | culture | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 275 | `d145b92d-40a3-44ee-be5c-d5293b23b6c1` | 大洲文化袋--亚洲 | prek | montessori | culture | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 276 | `f1b68ed8-87c3-4534-bc0d-216c8a78d2b1` | 国旗-旗帜 | prek | montessori | culture | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 277 | `8a65c86e-3c3c-4751-a17a-1706c482ac02` | 方位 方位的介绍1-南、北 | prek | montessori | culture | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 278 | `4c1f7ad6-e972-401d-ab2d-9dfe885a8d04` | 方位 方位的介绍2-东南西北 | prek | montessori | culture | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 279 | `16e12aff-2be3-4053-bb9b-96883004f7de` | 指南针的介绍 | prek | montessori | culture | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 280 | `5c6402a3-822b-4f18-98c3-400c6d57b6fe` | 地球构造 地球结构（地层） | prek | montessori | culture | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 281 | `cb568988-7f8d-4cbd-8dc3-401d715070a9` | 岩石 | prek | montessori | culture | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 282 | `45854d05-0885-4447-9543-63f936849524` | 火山 | prek | montessori | culture | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 283 | `6cdb4a89-32c0-4fc0-86df-664090e28164` | 地球的年龄——黑丝带 | prek | montessori | culture | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 284 | `147af680-f157-46e1-8b5b-3dfd68b1843b` | 过去现在未来——历史文物 | prek | montessori | culture | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 285 | `0061bbef-8aa7-4484-911d-23b3877072e2` | 过去现在未来——事物如何改变（过去、现在、未来） | prek | montessori | culture | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 286 | `bc9bd00f-a122-4008-97dd-0d981380b61a` | 过去现在未来——发明 | prek | montessori | culture | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 287 | `a26e2b84-81e8-44c0-9f3b-2751de04a046` | 时间的推移（天——时间的连续性） | prek | montessori | culture | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 288 | `59b5a4f9-9e5a-4cd8-be92-c0a1478a181b` | 时间的推移（天——每天的日记） | prek | montessori | culture | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 289 | `e301f237-eb07-4f16-be0f-34826b610633` | 时间的推移（天——日历课程） | prek | montessori | culture | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 290 | `bb0d523e-9fdb-4ff5-8b98-4951a1c55ebe` | 时间的推移（星期嵌板） | prek | montessori | culture | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 291 | `96dcdcc1-4717-41d6-a712-533894bbe7ba` | 时间的推移（月份嵌板） | prek | montessori | culture | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 292 | `b53da2b0-b17d-448e-b42a-3c8f72eee5af` | 时间的推移（四季三段卡） | prek | montessori | culture | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 293 | `9b66ad01-3e0e-477e-93ef-7c41a3fc71a6` | 时间的推移（年-生命发展过程） | prek | montessori | culture | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 294 | `ffabd84d-2605-40b6-ad6c-6c548ba1f655` | 时间的推移（生日漫步） | prek | montessori | culture | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 295 | `a47099c2-3314-404d-82a8-9cb964774108` | 读取时间——时钟 | prek | montessori | culture | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 296 | `d9dea47f-f0e6-451b-b548-ec869494ec81` | 国家历史——国家周期/朝代 | prek | montessori | culture | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 297 | `94d32c75-56f8-4214-85b6-246a2c7bad16` | 国家历史——国家庆典 | prek | montessori | culture | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 298 | `5431d899-123c-4f26-ace7-bf640cc9e734` | 国家历史——节日历史 | prek | montessori | culture | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 299 | `d08f2db0-0bd2-4fc8-8bd4-7a9c66d36937` | 三态认识 | prek | montessori | culture | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 300 | `2ee2af6c-4ad0-4bbd-ad45-52fde9e83ff2` | 三态分类（小物品/卡片） | prek | montessori | culture | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 301 | `36f79016-e4a1-4371-bc69-a6cc89a72dab` | 光的折射——三棱镜 | prek | montessori | culture | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 302 | `4ba85932-6543-4ba4-a459-228fae88dea6` | 放大镜 | prek | montessori | culture | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 303 | `27215f2f-6176-4c24-9e43-c38232c24118` | 传声筒 | prek | montessori | culture | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 304 | `2c34598a-46fa-4f80-b8a3-ce70e2e307a5` | 有磁性没有磁性 | prek | montessori | culture | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 305 | `3ecf3fbe-26f5-4f4a-b713-eb50f9bc08c0` | 相反磁性 | prek | montessori | culture | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 306 | `d5504c2f-ae3d-42a2-874f-6a3b2cd0965e` | 灯泡亮了 | prek | montessori | culture | courseware | `prek:montessori_resource` | 教育教学/Pre-K/蒙特梭利/教学资源 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 307 | `90f5269d-09d1-47fc-9537-56fc5d6ad8ca` | 主题1：我自己 - Theme Overview | k | english | — | curriculum_outline | `k:english_outline` | 教育教学/K/英文教学/课程大纲 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 308 | `30f6715b-bce4-4744-88bd-3e89779f3d4c` | 主题2：五感 - Theme Overview | k | english | — | curriculum_outline | `k:english_outline` | 教育教学/K/英文教学/课程大纲 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 309 | `dd6e42db-e441-456d-b514-d9ecce6c96e9` | 主题3：社区与邻里 - Theme Overview | k | english | — | curriculum_outline | `k:english_outline` | 教育教学/K/英文教学/课程大纲 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 310 | `7e6e8221-d09e-40f3-bf99-6acc6a401134` | 主题4：自然世界 - Theme Overview | k | english | — | curriculum_outline | `k:english_outline` | 教育教学/K/英文教学/课程大纲 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 311 | `52455a09-2555-41a4-bb56-4af0af3a93ba` | 主题5：项目式学习（PBL） - Theme Overview | k | english | — | curriculum_outline | `k:english_outline` | 教育教学/K/英文教学/课程大纲 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 312 | `3499dd97-24f2-4b04-a870-1230a4ff290a` | 主题6：环游世界 - Theme Overview | k | english | — | curriculum_outline | `k:english_outline` | 教育教学/K/英文教学/课程大纲 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 313 | `ca592c71-c783-4b02-9c52-5c9afc5e1ea4` | 主题1：我自己 - S1 W2 | k | english | — | weekly_plans | `k:english_lesson` | 教育教学/K/英文教学/教学详案 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 314 | `83c83b6b-bfad-4ed5-a156-f68d090a2bda` | 主题1：我自己 - S1 W3 | k | english | — | weekly_plans | `k:english_lesson` | 教育教学/K/英文教学/教学详案 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 315 | `cc31db69-a1ce-4c31-9df3-bb56cd8a4650` | 主题1：我自己 - S1 W4 | k | english | — | weekly_plans | `k:english_lesson` | 教育教学/K/英文教学/教学详案 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 316 | `e8d94f29-dba1-4c49-9582-9bbfda6a6727` | 主题1：我自己 - S1 W6 | k | english | — | weekly_plans | `k:english_lesson` | 教育教学/K/英文教学/教学详案 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 317 | `094d51a2-ba8c-4e2c-966a-5ed113fcc86a` | 主题2：五感 - S1 W7 | k | english | — | weekly_plans | `k:english_lesson` | 教育教学/K/英文教学/教学详案 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 318 | `7381c4a4-3091-4241-8dd7-02e213d2add7` | 主题2：五感 - S1 W8 | k | english | — | weekly_plans | `k:english_lesson` | 教育教学/K/英文教学/教学详案 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 319 | `6e73a500-60f2-494f-b8cc-8f2129f7d765` | 主题2：五感 - S1 W9 | k | english | — | weekly_plans | `k:english_lesson` | 教育教学/K/英文教学/教学详案 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 320 | `b46c30f8-4f74-494e-b2fe-32e75cf59a8a` | 主题2：五感 - S1 W10 | k | english | — | weekly_plans | `k:english_lesson` | 教育教学/K/英文教学/教学详案 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 321 | `7b75d5c5-54e2-4965-b7aa-01feecc10cd8` | 主题2：五感 - S1 W11 | k | english | — | weekly_plans | `k:english_lesson` | 教育教学/K/英文教学/教学详案 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 322 | `93cb5d2e-7d6b-4de7-b2f7-e450753b87fd` | 主题2：五感 - S1 W12 | k | english | — | weekly_plans | `k:english_lesson` | 教育教学/K/英文教学/教学详案 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 323 | `448cc2bc-65e1-4361-ab54-5daabf523d0e` | 主题2：五感 - S1 W13 | k | english | — | weekly_plans | `k:english_lesson` | 教育教学/K/英文教学/教学详案 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 324 | `2a9d40e2-4616-49cc-b8ed-1159da2669af` | 主题3：社区与邻里 - S1 W14 | k | english | — | weekly_plans | `k:english_lesson` | 教育教学/K/英文教学/教学详案 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 325 | `bf97069a-e7b8-4086-b90b-bbbd807f2dd7` | 主题3：社区与邻里 - S1 W15 | k | english | — | weekly_plans | `k:english_lesson` | 教育教学/K/英文教学/教学详案 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 326 | `61f55b12-9594-4f88-ac8d-d6b187fbcefe` | 主题3：社区与邻里 - S1 W16 | k | english | — | weekly_plans | `k:english_lesson` | 教育教学/K/英文教学/教学详案 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 327 | `b974b1cc-b645-49bf-956c-a9b1acbbc905` | 主题3：社区与邻里 - S1 W17 | k | english | — | weekly_plans | `k:english_lesson` | 教育教学/K/英文教学/教学详案 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 328 | `0a0b14fc-5d0d-4ba1-97c4-d7dc55e35a5d` | 主题4：自然世界 - S1 W19 | k | english | — | weekly_plans | `k:english_lesson` | 教育教学/K/英文教学/教学详案 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 329 | `147905e5-92cf-4d01-ad51-385f0d0a919b` | 主题4：自然世界 - S1 W20 | k | english | — | weekly_plans | `k:english_lesson` | 教育教学/K/英文教学/教学详案 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 330 | `8a32ea89-f5bf-42b2-a1f4-79f16837db62` | 主题4：自然世界 - S1 W21 | k | english | — | weekly_plans | `k:english_lesson` | 教育教学/K/英文教学/教学详案 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 331 | `b4d76aaa-cce3-491a-ac4d-71bfcbf76e8e` | 主题5：项目式学习（PBL） - S2 W1 | k | english | — | weekly_plans | `k:english_lesson` | 教育教学/K/英文教学/教学详案 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 332 | `771e5daf-021c-46a1-a51b-4031b55a9722` | 主题5：项目式学习（PBL） - S2 W2 | k | english | — | weekly_plans | `k:english_lesson` | 教育教学/K/英文教学/教学详案 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 333 | `297bc903-0f6a-4fc2-adf6-13f330675d71` | 主题5：项目式学习（PBL） - S2 W3 | k | english | — | weekly_plans | `k:english_lesson` | 教育教学/K/英文教学/教学详案 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 334 | `776c3b84-309d-4cba-b113-fb1fdb5dcb99` | 主题5：项目式学习（PBL） - S2 W4 | k | english | — | weekly_plans | `k:english_lesson` | 教育教学/K/英文教学/教学详案 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 335 | `912b9b54-0b6a-442e-adb3-9a230fd7cb0c` | 主题5：项目式学习（PBL） - S2 W5 | k | english | — | weekly_plans | `k:english_lesson` | 教育教学/K/英文教学/教学详案 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 336 | `497fe23e-63a4-4f3d-a2a4-9bb4463f4a71` | 主题5：项目式学习（PBL） - S2 W6 | k | english | — | weekly_plans | `k:english_lesson` | 教育教学/K/英文教学/教学详案 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 337 | `03ef8957-656c-4c67-8e0a-823f3536dc72` | 主题6：环游世界 - S2 W11 | k | english | — | weekly_plans | `k:english_lesson` | 教育教学/K/英文教学/教学详案 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 338 | `da45616f-c477-4d33-99b4-35560249054c` | 主题5：项目式学习（PBL） - S2 W7 | k | english | — | weekly_plans | `k:english_lesson` | 教育教学/K/英文教学/教学详案 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 339 | `9ed561a4-e0ec-4327-8a51-05263db49a31` | 主题5：项目式学习（PBL） - S2 W8 | k | english | — | weekly_plans | `k:english_lesson` | 教育教学/K/英文教学/教学详案 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 340 | `70e45796-93a6-4a45-8962-171c9dfe3846` | 主题5：项目式学习（PBL） - S2 W9 | k | english | — | weekly_plans | `k:english_lesson` | 教育教学/K/英文教学/教学详案 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 341 | `cbead687-4552-4265-88bb-3dba6a478685` | 主题6：环游世界 - S2 W10 | k | english | — | weekly_plans | `k:english_lesson` | 教育教学/K/英文教学/教学详案 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 342 | `e75bf02f-a0a7-4ed3-a226-fbfa4c3a70d5` | 主题6：环游世界 - S2 W12 | k | english | — | weekly_plans | `k:english_lesson` | 教育教学/K/英文教学/教学详案 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 343 | `d14d4cd4-a904-4c26-99b9-21d9348c0650` | 主题6：环游世界 - S2 W13 | k | english | — | weekly_plans | `k:english_lesson` | 教育教学/K/英文教学/教学详案 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 344 | `05b6e7d8-9578-467c-8487-9648790cb101` | 主题6：环游世界 - S2 W14 | k | english | — | weekly_plans | `k:english_lesson` | 教育教学/K/英文教学/教学详案 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 345 | `b8f25b53-2482-4737-9d60-2f19fdfb8357` | 主题6：环游世界 - S2 W15 | k | english | — | weekly_plans | `k:english_lesson` | 教育教学/K/英文教学/教学详案 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 346 | `da466d75-1a55-4eb8-be6d-e4f6cc5d2a9e` | 主题6：环游世界 - S2 W16 | k | english | — | weekly_plans | `k:english_lesson` | 教育教学/K/英文教学/教学详案 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
| 347 | `4612f8b6-e00d-443a-bcf6-2dc5263fe2ca` | 主题6：环游世界 - Unit Summary | k | english | — | weekly_plans | `k:english_lesson` | 教育教学/K/英文教学/教学详案 | 精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级） |
