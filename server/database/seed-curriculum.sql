-- ============================================================
-- 清澜山幼儿园课程资源 Seed Data (v2)
-- 数据来源：原型 HTML（https://aka.doubaocdn.com/s/Fd6QUwkKh7）
-- 幂等保证：所有 INSERT 均带 NOT EXISTS 防重复
-- ============================================================

BEGIN;

-- 先清理旧的课程资源（仅 system_initializer 上传的课程数据，不动教师/权限表）
DELETE FROM resources WHERE uploader_id = (SELECT id FROM teachers WHERE wecom_user_id = 'system_initializer');


-- ============================================================
-- 1. Pre-K 美德课程 - 课程大纲 (10 个主题位置)
-- ============================================================

INSERT INTO resources (title, title_en, program, subject, folder_type, theme, status, uploader_id, description, version)
SELECT '美德 - 礼貌 主题', 'Virtue - 礼貌 Theme', 'prek', 'virtue', 'curriculum_outline',
       '礼貌', 'published', t.id, '{"code": "11.01", "month": "九月", "gem": "礼貌红", "color": "#b84a54", "owner": "Pre-K 美德教研组", "definition": "礼貌是良好的举止，它体现对他人的尊重、关心和体贴。礼貌的言行举止能够增进人与人之间的和谐关系，减少误解和冲突。", "alias": "九月 · 礼貌红", "monthly": ["蒙氏工作时间融入“优雅与礼仪”常规，在语言区投放“请、谢谢、不客气、对不起、没关系”等礼貌用语工作。", "日常中持续强化问候、告别、感谢、请求帮助、自我介绍、开启话题、倾听和轮流交谈。", "教师示范准时、坐与站、室内轻声说话、走路的脚、排队、不打断他人、回应他人、尊重长者和访客、听从指令、轻轻开关门、扶门等常规。", "明确物品使用原则：温柔礼貌、双手传递物品、轻拿轻放、用后归位。"], "weekly": [{"week": "W1", "focus": "打招呼", "books": "《神奇的“你好！”》；《你好》", "activity": "多种方式打招呼：礼仪小助手、幼儿创意打招呼、变化打招呼对象，并了解不同国家打招呼的语言或方式。", "discussion": "见面或分别时可以如何打招呼？为什么要打招呼，打招呼有什么作用？"}, {"week": "W2", "focus": "说谢谢", "books": "《我会说谢谢》；《谢谢，谢谢你》", "activity": "双手传递物品，说谢谢；可玩“请把帽子递过来”，延伸为向不同的人道谢，并练习回应“不客气”。", "discussion": "他人给我们东西或帮助我们时，怎样做是礼貌的？什么时候说谢谢？别人感谢我们时如何回应？"}, {"week": "W3", "focus": "有礼貌的魔力", "books": "《有礼貌的小熊熊》；《有魔力的话》；《不要随便说，要有礼貌》", "activity": "传递“魔法语言”，设置魔法话语小宝箱，收集请、谢谢、对不起、没关系等有魔力的话。", "discussion": "你知道哪些礼貌用语？什么时候会说这些“有魔力的话”？"}, {"week": "W4", "focus": "复杂情境中的礼貌", "books": "《请问我可以吃块饼干吗》；《你别想让河马走开》", "activity": "四选一情景表演：礼貌打断、请帮忙、请问我可以……吗、请求让路。", "discussion": "需要帮助、想摸或想得到物品、需要别人让路时，应该怎么说、怎么做才礼貌？"}], "resources": ["《我懂礼貌》", "《优雅与礼仪》画册（蒙氏金刚）", "视频：第十二集 小孩子要懂礼貌", "讲话棒", "礼仪之邦古代礼仪图片"], "isReserved": false}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'virtue'
      AND r.folder_type = 'curriculum_outline'
      AND COALESCE(r.theme, '') = '礼貌'
      AND r.title = '美德 - 礼貌 主题'
  );

INSERT INTO resources (title, title_en, program, subject, folder_type, theme, status, uploader_id, description, version)
SELECT '美德 - 整洁 主题', 'Virtue - 整洁 Theme', 'prek', 'virtue', 'curriculum_outline',
       '整洁', 'published', t.id, '{"code": "11.02", "month": "十月", "gem": "整洁紫", "color": "#7561a4", "owner": "Pre-K 美德教研组", "definition": "整洁是经常换洗衣物、保持身体洁净、穿干净整洁的衣服；也意味着保持房间有序和干净，为保持全家井井有条做出贡献。", "alias": "十月 · 整洁紫", "monthly": ["蒙氏照顾自己：擤鼻涕、擦嘴巴、洗手、梳头发、折布、收叠行李箱、洗衣物、收拾整理衣物。", "蒙氏照顾环境：除尘、扫地、擦镜子、擦玻璃、擦亮物品、擦桌子、洗物品、洗桌子、擦叶子。", "食物准备工作：洗水果或蔬菜；户外活动可进行听觉版“这是整洁吗”游戏。", "教师用“我的……很整洁”“你的……很整洁”“某个地方很整洁”等语言强化，并从个人、个人物品和环境三个维度观察展示。"], "weekly": [{"week": "W1", "focus": "整洁与不整洁", "books": "《琪琪和贾克斯》；“这是整洁吗”游戏", "activity": "通过绘本和整洁/不整洁图片进行分类判断。", "discussion": "你现在穿的衣服整洁吗？教室、家里或你见过的什么地方让你觉得很整洁？"}, {"week": "W2", "focus": "个人的整洁：整洁的脸", "books": "整洁主题活动", "activity": "准备镜子、纸巾、小垃圾桶、一张“脸”和一些“脏东西”，练习擦嘴、擦鼻涕、洗手和照镜子自查。", "discussion": "我们身上有哪些需要保持整洁的地方？饭后、流鼻涕时可以怎样让自己变整洁？"}, {"week": "W3", "focus": "整理物品：物品整理挑战", "books": "物品分类工作", "activity": "准备一些用于分类的物品、对应种类数量的箱子和三份工作，练习玩具、工作、书包等物品归位。", "discussion": "你收拾过哪些物品？整理前可能发生什么？整理后给你什么感觉？"}, {"week": "W4", "focus": "环境的整洁", "books": "照顾环境的工作 / “找找 XX 在哪里”（二选一）", "activity": "活动一准备一份照顾环境工作所需材料；活动二通过寻找物品，理解每样物品都有固定位置。", "discussion": "幼儿园里哪里可能有灰尘、纸屑、洒落食物、水渍或物品不在原位？我们有什么办法让这些地方变整洁？"}], "resources": ["整洁主题歌曲", "整洁与不整洁图片", "镜子、纸巾、小垃圾桶", "分类物品和箱子", "清洁工具套装"], "isReserved": false}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'virtue'
      AND r.folder_type = 'curriculum_outline'
      AND COALESCE(r.theme, '') = '整洁'
      AND r.title = '美德 - 整洁 主题'
  );

INSERT INTO resources (title, title_en, program, subject, folder_type, theme, status, uploader_id, description, version)
SELECT '美德 - 感恩 主题', 'Virtue - 感恩 Theme', 'prek', 'virtue', 'curriculum_outline',
       '感恩', 'published', t.id, '{"code": "11.03", "month": "十一月", "gem": "感恩绿", "color": "#4f8463", "owner": "Pre-K 美德教研组", "definition": "感恩是深深地感谢父母的照顾，感谢生命所需的氧气、干净的水源、供给食物的地球；也感谢身体感官、生命本身，以及生活每天带来的礼物。我们可以选择感恩所拥有的一切。", "alias": "十一月 · 感恩绿", "monthly": ["蒙氏工作：感恩卡片、落叶信封（感谢他人的方式）、食物准备与分享、照顾植物、南瓜生命周期、地理——大自然的馈赠。", "教师在日常中引导孩子用感恩的心享受食物，在别人帮助时说“谢谢”。", "语言示范：“亲爱的……我要谢谢你！”“我感谢……（一个事物）”。", "感恩行动从家人、朋友、老师、幼儿园里的其他人，延伸到自然、地球和生命本身。"], "weekly": [{"week": "W1", "focus": "感恩家人", "books": "家人照顾孩子的图片或视频", "activity": "制作感恩树、感恩链或其他感恩表征；准备家人照顾孩子的图片/视频。", "discussion": "我们如何在家中表现感恩？家人为我们做了什么？"}, {"week": "W2", "focus": "感恩身边的美好", "books": "《谢谢！谢谢！》", "activity": "“感恩礼物盒”开箱游戏，准备绘本和“感恩礼物盒”PPT。", "discussion": "生活中有哪些小小的美好值得感谢？"}, {"week": "W3", "focus": "感恩身边的人：我的生活感恩有你", "books": "《彩虹色的花》", "activity": "传递“彩虹色的花”给想感谢的朋友；准备绘本展示道具和用于传递的花。", "discussion": "在幼儿园里你可以感谢哪些人？我们怎样对他们表达感谢？"}, {"week": "W4", "focus": "感恩自己", "books": "《眼泪小精灵，谢谢你》；《我喜欢我自己》（二选一）", "activity": "制作感恩贴，老师送出感谢爱心卡；准备贴纸、爱心卡和身体各部分图片。", "discussion": "你想感谢自己的什么？如果朋友送的礼物我们并不喜欢，该怎么办？"}], "resources": ["歌曲：《亲爱的谢谢你》", "感恩主题歌曲", "落叶信封材料", "南瓜生命周期材料", "感恩树/感恩链材料"], "isReserved": false}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'virtue'
      AND r.folder_type = 'curriculum_outline'
      AND COALESCE(r.theme, '') = '感恩'
      AND r.title = '美德 - 感恩 主题'
  );

INSERT INTO resources (title, title_en, program, subject, folder_type, theme, status, uploader_id, description, version)
SELECT '美德 - 慷慨 主题', 'Virtue - 慷慨 Theme', 'prek', 'virtue', 'curriculum_outline',
       '慷慨', 'published', t.id, '{"code": "11.04", "month": "十二月", "gem": "慷慨粉", "color": "#c97892", "owner": "Pre-K 美德教研组", "definition": "对幼儿园小朋友来说，慷慨是友好和乐于助人的表现，包括分享、轮流、帮助有需要的人、为他人提供帮助、表达欣赏和赞美、慷慨表达感谢，并用开放的心接纳和邀请他人。不要求他人分享。", "alias": "十二月 · 慷慨粉", "monthly": ["“爱心树”：在美术区制作爱心树展示板，孩子把观察到或自己做出的慷慨行动画在爱心树叶上并贴到树上。", "“慷慨厨房”：组织简单烘焙活动，一起制作爱心曲奇小饼干，并思考可以分享给谁。", "日常中区分分享玩具、分享食物、提供帮助、倾听支持、给予赞美、制作小卡片、邀请参与和包容不同朋友。", "强调分享必须出于自愿，不把“不分享”简单等同于不慷慨。"], "weekly": [{"week": "W1", "focus": "乐于助人，慷慨给予（帮助）", "books": "《彩虹色的花》", "activity": "“假如我是彩虹色的花”角色扮演，准备彩虹色的头戴花。", "discussion": "别人遇到困难时，我们可以怎样提供帮助？"}, {"week": "W2", "focus": "学会分享，感受快乐", "books": "《我是彩虹鱼》；《谢谢您，阿嬷》", "activity": "制作彩虹鱼、挖宝石赠与活动；准备打印材料、漂亮贴纸/大盆、沙、漂亮的宝石。", "discussion": "分享之后你有什么感受？有哪些东西可以一起玩或轮流用？"}, {"week": "W3", "focus": "学会赞美，积极社交", "books": "《你很特别》", "activity": "互相贴星星赞美活动，准备星星贴纸，练习具体赞美他人的努力和优点。", "discussion": "你发现同伴身上有什么特别的优点？怎样让别人感到被看见和鼓励？"}, {"week": "W4", "focus": "练习课", "books": "待定", "activity": "根据班级真实情境进行慷慨、帮助、轮流、邀请和赞美的综合情景练习。", "discussion": "回顾本月自己做过的一次慷慨行动，以及下次可以尝试的行动。"}], "resources": ["《彩虹色的花》课件", "《我是彩虹鱼》", "《你很特别》", "《我喜欢你》", "《爱心树》课件", "《美德在行动系列绘本——慷慨》", "音乐：和平烛光"], "isReserved": false}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'virtue'
      AND r.folder_type = 'curriculum_outline'
      AND COALESCE(r.theme, '') = '慷慨'
      AND r.title = '美德 - 慷慨 主题'
  );

INSERT INTO resources (title, title_en, program, subject, folder_type, theme, status, uploader_id, description, version)
SELECT '美德 - 团结 主题', 'Virtue - 团结 Theme', 'prek', 'virtue', 'curriculum_outline',
       '团结', 'published', t.id, '{"code": "11.05", "month": "一月—二月", "gem": "团结玫红", "color": "#b64f73", "owner": "Pre-K 美德教研组", "definition": "团结能把不同的人和事连接在一起，就像拼一幅拼图。孩子们学习合作、一起工作、玩耍、学习和互相帮助，同时尊重彼此的不同，发现他人身上的优点，增强班集体的力量。", "alias": "一月—二月 · 团结玫红", "monthly": ["文档未单设每月活动，团结主题通过每周合作活动、班级共同生活、冲突解决和日常互助持续渗透。", "教师在班级中强调相互尊重、包容、接纳每个孩子的独特性，并用合作任务让孩子体验共同目标。"], "weekly": [{"week": "W1", "focus": "团结力量大，我们一起来帮忙", "books": "《蚂蚁和西瓜》", "activity": "合作搬抬重物，准备绘本和安全、适合共同搬运的轻量“重物”。", "discussion": "一个人搬不动的时候怎么办？大家一起合作会发生什么变化？"}, {"week": "W2", "focus": "一起合作更厉害", "books": "《月亮的味道》或《拔萝卜》", "activity": "户外抱树或拔河，准备绘本；无拔河绳时可进行抱树合作游戏。", "discussion": "每个人在合作中分别做了什么？怎样配合才能更顺利？"}, {"week": "W3", "focus": "我们在一起——团结友爱真快乐", "books": "《好伙伴不吵架》", "activity": "“小小的我们，大大的友谊”，准备绘本和图卡，讨论朋友吵架后如何和好。", "discussion": "和朋友意见不一样时怎么办？我们可以怎样关心同伴？"}, {"week": "W4", "focus": "齐心协力", "books": "《好伙伴不要吵》", "activity": "默契大考验，准备绘本和用以移动的工具/物品，完成需要沟通和配合的小组任务。", "discussion": "什么是齐心协力？团队里有人慢一点或想法不同，我们可以怎么做？"}], "resources": ["团结主题歌曲", "《我们在一起》", "《团结就是力量》", "《我们都是好朋友》手势舞", "合作搬运材料"], "isReserved": false}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'virtue'
      AND r.folder_type = 'curriculum_outline'
      AND COALESCE(r.theme, '') = '团结'
      AND r.title = '美德 - 团结 主题'
  );

INSERT INTO resources (title, title_en, program, subject, folder_type, theme, status, uploader_id, description, version)
SELECT '美德 - 耐心 主题', 'Virtue - 耐心 Theme', 'prek', 'virtue', 'curriculum_outline',
       '耐心', 'published', t.id, '{"code": "11.06", "month": "三月", "gem": "耐心宝蓝", "color": "#2368a6", "owner": "Pre-K 美德教研组", "definition": "耐心是不急躁、不厌烦，是在等待时不抱怨，在遇到延迟、麻烦或困难时保持冷静和容忍；也是持之以恒、坚持到底，相信种下的种子需要时间，总有一天会开花结果。", "alias": "三月 · 耐心宝蓝 · 每月事件：种植", "monthly": ["日常中练习耐心等待一份工作、一个座位、排队口令、户外滑梯/秋千和打餐；练习举手被邀请、等待他人结束谈话。", "练习耐心倾听、耐心观察、耐心照顾他人、和平解决冲突、耐心协调并团结行动。", "完成需要耐心的工作：串珠、考古、使用后恢复工作、数学工作、插花、舞蹈/乐器/下棋/歌唱等重复练习。", "教给孩子四种让等待变轻松的方法：笑着等待并期待、可视化深呼吸、数数、选择另一件想做的事；方法来源为《耐心小书》。", "每月事件：种植，让孩子在播种、照顾和记录变化中体验等待与成长。"], "weekly": [{"week": "W1", "focus": "静待花开——对环境有耐心", "books": "《安的种子》", "activity": "种植活动：像安一样种下种子，按步骤播种，邀请幼儿帮忙，讨论如何照顾并记录变化。材料：种植材料。", "discussion": "种子种下后会立刻开花吗？我们可以怎样照顾它、等待它成长？"}, {"week": "W2", "focus": "等待爆米花开——练习静下心等待", "books": "《Waiting Is Not Easy》", "activity": "爆米花游戏：可无材料听数字爆开，也可摸头点数 1–3，或用沙漏/计时器倒数；练习专心听、看并等待那一刻。", "discussion": "等待时心里有什么感觉？深呼吸、数数、笑着期待或换一件事做，哪一种方法最能帮助你？"}, {"week": "W3", "focus": "鼓励坚持不懈——耐心不放弃", "books": "《一只很没耐心很没耐心的毛毛虫——小蝴蝶飞越沧海》", "activity": "场景扮演：回顾故事中的鼓励话语，展示孩子完成挑战任务的照片，教师扮演照片中的孩子描述心理活动，幼儿练习说鼓励耐心的话。", "discussion": "遇到困难想放弃时，可以对自己或朋友说什么？“再试一次”“越来越近了”会带来什么变化？"}, {"week": "W4", "focus": "我有耐心——练习数数等待", "books": "《我有耐心》", "activity": "挖宝石：幼儿传递宝石箱，在米/沙容器或神秘袋中等待轮到自己找宝石；等待时心里默数，结束后获得一颗耐心宝石。材料：宝石、米或沙、容器。", "discussion": "本月你在什么时候练习了耐心？等待轮到自己时，数数可以怎样帮助我们？"}], "resources": ["《安的种子》", "《等待不容易》中文版", "《一只很没耐心很没耐心的毛毛虫——小蝴蝶飞越沧海》", "《我有耐心》", "补充绘本：《我愿意等，熊猫先生》《一会儿要等多久》《等啊等啊等》《排队啦，排队啦》", "爆米花视频与计时器", "宝石：1 个/孩子"], "isReserved": false}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'virtue'
      AND r.folder_type = 'curriculum_outline'
      AND COALESCE(r.theme, '') = '耐心'
      AND r.title = '美德 - 耐心 主题'
  );

INSERT INTO resources (title, title_en, program, subject, folder_type, theme, status, uploader_id, description, version)
SELECT '美德 - 诚实 主题', 'Virtue - 诚实 Theme', 'prek', 'virtue', 'curriculum_outline',
       '诚实', 'published', t.id, '{"code": "11.07", "month": "四月", "gem": "诚实天蓝", "color": "#3f95c8", "owner": "Pre-K 美德教研组", "definition": "有时人们会因为担心说实话带来麻烦而撒谎。能讲真话意味着有勇气承认错误；诚实意味着无论结果怎样都说出事实，它能让人变得坚强，也让其他美德更好地发展。", "alias": "四月 · 诚实天蓝 · 每月事件：判断虚实", "monthly": ["在展示区投放图片或绘本，让孩子判断真实与想象/虚构；每班更换频率不少于每两周一次，并提前做月计划。", "区分幻想型故事、信任、逃避批评、模仿型“我也有”、拿别人东西、根据部分信息猜想、承诺、善意的谎言、过于直接的实话和试探规则等情境。", "对“我有/我也有”的社交模仿，引导孩子具体描述颜色和特征，使用“我的朋友有……，我的是……”句式理解差异。", "引导孩子理解：说实话要看时机、方法和理由；诚实不是不顾他人感受的直言。"], "weekly": [{"week": "W1", "focus": "诚实是美好品德", "books": "《手捧空花盆的孩子》", "activity": "分辨真假游戏：教师展示图片，幼儿分辨真实和不真实，并用相应手势作答。材料：图片。", "discussion": "国王为什么选择手捧空花盆的孩子？什么是实事求是？"}, {"week": "W2", "focus": "不讲真话的结果", "books": "《狼来了》", "activity": "绘本角色扮演：讨论角色情绪，邀请幼儿扮演村民和放羊孩子，总结持续说谎会失去信任。材料：扮演头饰或其他材料。", "discussion": "村民为什么后来不再相信放羊的孩子？总是不讲真话会怎样影响别人对我们的信任？"}, {"week": "W3", "focus": "说出真相的勇气", "books": "《迟到的理由》或《我不敢说我怕被骂》", "activity": "担心气球：用“情景—事实—我的想法—心理状态”决策故事卡，说谎时吹大气球，说出真话时放气，让孩子看见并触摸担心的变化。材料：决策故事卡、气球 1 个。", "discussion": "把秘密藏在心里时身体有什么感觉？为什么说出来反而更容易被理解、得到帮助？"}, {"week": "W4", "focus": "你有我也有？", "books": "《请不要随便说谎》", "activity": "描绘幼儿心理活动的情景表演：用诚实牌/说谎牌表现忘记收工作、没冲厕所、谎称吃过早餐、多拿食物、想把班级石头带回家等决策瞬间，由幼儿决定故事结局。材料：日常故事、决策牌。", "discussion": "当我们很想拥有、很想加入话题或害怕被批评时，怎样做才是诚实？可以向谁求助？"}], "resources": ["歌曲：《好孩子要诚实》、诚实之歌", "《手捧空花盆的孩子》", "《狼来了》及头饰", "《迟到的理由》", "《我不敢说我怕被骂》", "《请不要随便说谎》", "《谎话怪兽》课件", "《妈妈，我错了》", "《打破杯子的鼠小弟》", "补充绘本：《盲人摸象》《随便拿别人东西可不行》《用爱心说实话》", "决策故事卡、决策牌、气球"], "isReserved": false}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'virtue'
      AND r.folder_type = 'curriculum_outline'
      AND COALESCE(r.theme, '') = '诚实'
      AND r.title = '美德 - 诚实 主题'
  );

INSERT INTO resources (title, title_en, program, subject, folder_type, theme, status, uploader_id, description, version)
SELECT '美德 - 服务 主题', 'Virtue - 服务 Theme', 'prek', 'virtue', 'curriculum_outline',
       '服务', 'published', t.id, '{"code": "11.08", "month": "五月", "gem": "服务草绿", "color": "#6f9c43", "owner": "Pre-K 美德教研组", "definition": "服务是通过行动、劳动或资源为他人或组织提供帮助、满足需求、创造价值。幼儿园阶段的服务是在日常小事中播种善意，让孩子体验“我能让别人的生活更好”，并形成能力感、快乐感和社会归属感。", "alias": "五月 · 服务草绿 · 每月事件：服务卡 / 服务天使", "monthly": ["服务月开展服务卡或服务天使活动：幼儿佩戴服务标志，在一个月中尝试为他人提供力所能及的服务并感受心情。", "引导孩子经历“理解他人需求—建立责任感—采取行动—讨论感受”的过程，成人做好榜样并给出具体反馈。", "蒙氏服务工作包括布置餐桌、擦桌子/洗桌子、叠毛巾、全班制作食物并到其他班级分享；生活帮助包括帮更小的孩子穿外套、帮同学捡物品等。", "练习服务语言：“我可以帮你做……来为你服务吗？”“很开心能为你服务！”接受服务时微笑说“谢谢”。", "守住边界：服务必须自愿、任务符合年龄且安全，平衡自我与他人需求，不把服务变成机械任务或过度牺牲。"], "weekly": [{"week": "W1", "focus": "用服务表达爱——母亲节：理解需求和行动起来", "books": "“妈妈为我们服务”课件或视频", "activity": "讨论妈妈为我们做了什么、妈妈的喜好和让妈妈开心的事；选择并装饰母亲节服务券。服务券可包含做饭、床上早餐、安静一小时、摆鞋、按摩、说我爱你、倒水、整理餐桌、搬快递、亲手做礼物等。", "discussion": "妈妈有哪些需求？我可以为妈妈提供什么既安全又力所能及的服务？"}, {"week": "W2", "focus": "服务的双手传递善行：手的功用和服务的意义", "books": "传递善行、服务他人视频（三选一）", "activity": "服务小天使 + 集体艺术作品“服务之手”：孩子选择/抽取服务项目，佩戴标志服务他人；通过印手印、贴爱心等方式共同创作服务之手壁画。", "discussion": "我们的手可以为同学、老师和环境做什么？当别人因为我的行动变得方便时，我有什么感受？"}, {"week": "W3", "focus": "认真快乐的服务员：了解服务的感受", "books": "《一家好认真好认真的餐厅》", "activity": "学习餐厅服务员歌曲，进行餐厅情景表演，练习擦桌、摆盘、放刀叉、点餐和友善服务；观众用口头“五星好评”反馈。材料：餐厅歌曲、表演道具。", "discussion": "谁在认真提供服务？他是怎么做的？接受友善热情的服务时感觉如何？"}, {"week": "W4", "focus": "世界需要每个人的贡献：不同职业提供不同服务", "books": "《忙忙碌碌镇》或《你的手我的手他的手》", "activity": "“你比我猜”：回顾职业和服务行为，教师先比划端饭、拿购物袋、洗碗、捡垃圾等动作让幼儿猜，再邀请幼儿表演。", "discussion": "社会上有哪些人在为我们服务？不同职业分别用什么行动帮助别人？"}], "resources": ["服务主题歌曲", "《用善意点亮世界》", "世界慈善日主题动画", "《善意回旋镖》", "母亲节服务视频与课件", "服务券材料", "服务小天使标志", "集体艺术作品材料", "《一家好认真好认真的餐厅》", "餐厅服务员歌曲视频", "《忙忙碌碌镇》", "《你的手我的手他的手》"], "isReserved": false}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'virtue'
      AND r.folder_type = 'curriculum_outline'
      AND COALESCE(r.theme, '') = '服务'
      AND r.title = '美德 - 服务 主题'
  );

INSERT INTO resources (title, title_en, program, subject, folder_type, theme, status, uploader_id, description, version)
SELECT '美德 - 快乐 主题', 'Virtue - 快乐 Theme', 'prek', 'virtue', 'curriculum_outline',
       '快乐', 'published', t.id, '{"code": "11.09", "month": "六月", "gem": "快乐黄", "color": "#d8a939", "owner": "Pre-K 美德教研组", "definition": "第二学期文档在“快乐”标题下标注“待上传内容”，尚未提供美德释义、日常活动和每周活动。", "alias": "六月 · 快乐黄 · 文档标注待上传", "monthly": ["待补充：六月快乐主题的每月活动、日常强化和课程资源。"], "weekly": [], "resources": ["待补充"], "isReserved": false, "pendingNote": "该主题在上传的《Pre-K美德课 第二学期》文档中仅出现标题，正文标注为“待上传内容”。原型保留主题位置，待后续详案补齐。"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'virtue'
      AND r.folder_type = 'curriculum_outline'
      AND COALESCE(r.theme, '') = '快乐'
      AND r.title = '美德 - 快乐 主题'
  );

INSERT INTO resources (title, title_en, program, subject, folder_type, theme, status, uploader_id, description, version)
SELECT '美德 - 预留美德主题 主题', 'Virtue - Reserved Virtue Theme Theme', 'prek', 'virtue', 'curriculum_outline',
       '预留美德主题', 'published', t.id, '{"code": "11.10", "month": "待定 / TBD", "gem": "待确认 / TBD", "color": "#999999", "owner": "Pre-K 美德教研组", "definition": "第 10 个美德主题待园本确认后补充。", "alias": "第二份文档仅到 11.09 快乐，第 10 主题待园本确认", "monthly": [], "weekly": [], "resources": [], "isReserved": true}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'virtue'
      AND r.folder_type = 'curriculum_outline'
      AND COALESCE(r.theme, '') = '预留美德主题'
      AND r.title = '美德 - 预留美德主题 主题'
  );


-- ============================================================
-- 2. Pre-K 蒙特梭利 - 各区域大纲 (curriculum_outline)
-- ============================================================

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, status, uploader_id, description, version)
SELECT '蒙特梭利 - 日常生活区工作清单', 'Montessori - Practical Life Area Work List',
       'prek', 'montessori', 'practical_life', 'curriculum_outline',
       'published', t.id, '{"area": "日常生活", "areaEn": "Practical Life", "totalItems": 79, "description": "日常生活区工作项总数：79 项。详细工作清单请查看各分类。", "descriptionEn": "Practical Life area total work items: 79. See categories for detailed work list."}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'practical_life'
      AND r.folder_type = 'curriculum_outline'
      AND r.title = '蒙特梭利 - 日常生活区工作清单'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, status, uploader_id, description, version)
SELECT '蒙特梭利 - 感官区工作清单', 'Montessori - Sensorial Area Work List',
       'prek', 'montessori', 'sensorial', 'curriculum_outline',
       'published', t.id, '{"area": "感官", "areaEn": "Sensorial", "totalItems": 32, "description": "感官区工作项总数：32 项。详细工作清单请查看各分类。", "descriptionEn": "Sensorial area total work items: 32. See categories for detailed work list."}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'sensorial'
      AND r.folder_type = 'curriculum_outline'
      AND r.title = '蒙特梭利 - 感官区工作清单'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, status, uploader_id, description, version)
SELECT '蒙特梭利 - 数学区工作清单', 'Montessori - Math Area Work List',
       'prek', 'montessori', 'math', 'curriculum_outline',
       'published', t.id, '{"area": "数学", "areaEn": "Math", "totalItems": 36, "description": "数学区工作项总数：36 项。详细工作清单请查看各分类。", "descriptionEn": "Math area total work items: 36. See categories for detailed work list."}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'math'
      AND r.folder_type = 'curriculum_outline'
      AND r.title = '蒙特梭利 - 数学区工作清单'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, status, uploader_id, description, version)
SELECT '蒙特梭利 - 英文语言区工作清单', 'Montessori - English Language Area Work List',
       'prek', 'montessori', 'english_language', 'curriculum_outline',
       'published', t.id, '{"area": "英文语言", "areaEn": "English Language", "totalItems": 0, "description": "英文语言区按教学周组织，共 39 个教学周 + 3 个假期/校历列。详细内容请查看「周次教案」资料夹。", "descriptionEn": "English Language area is organized by teaching weeks: 39 teaching weeks + 3 holiday/calendar columns. Please see Weekly Lesson Plans folder for details."}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'english_language'
      AND r.folder_type = 'curriculum_outline'
      AND r.title = '蒙特梭利 - 英文语言区工作清单'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, status, uploader_id, description, version)
SELECT '蒙特梭利 - 中文语言区工作清单', 'Montessori - Chinese Language Area Work List',
       'prek', 'montessori', 'chinese_language', 'curriculum_outline',
       'published', t.id, '{"area": "中文语言", "areaEn": "Chinese Language", "totalItems": 0, "description": "工作项总数：0 项（源资料待补充 / Not filled in source）", "descriptionEn": "Total work items: 0 (Not filled in source)"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'chinese_language'
      AND r.folder_type = 'curriculum_outline'
      AND r.title = '蒙特梭利 - 中文语言区工作清单'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, status, uploader_id, description, version)
SELECT '蒙特梭利 - 文化区工作清单', 'Montessori - Culture Area Work List',
       'prek', 'montessori', 'culture', 'curriculum_outline',
       'published', t.id, '{"area": "文化", "areaEn": "Culture", "totalItems": 98, "description": "文化区工作项总数：98 项。详细工作清单请查看各分类。", "descriptionEn": "Culture area total work items: 98. See categories for detailed work list."}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'culture'
      AND r.folder_type = 'curriculum_outline'
      AND r.title = '蒙特梭利 - 文化区工作清单'
  );


-- ============================================================
-- 3. Pre-K 蒙特梭利英文语言区 - 42 周计划 (weekly_plans)
-- 39 个教学周 + 3 个假期/校历列
-- ============================================================

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, semester, week_number, status, uploader_id, description, version)
SELECT '英文语言 - W1 - Welcome to Pre-K', 'English Language - W1 - Welcome to Pre-K',
       'prek', 'montessori', 'english_language', 'weekly_plans',
       'S1', 1, 'published', t.id, '{"weekIndex": 1, "kind": "teaching", "weekLabel": "W1", "dateRange": "Aug 24th–Aug 28th", "calendarNote": "", "theme": "Welcome to Pre-K", "unit": "Introduction & Review", "focus": "First Week", "essentialQuestion": "", "storybooks": [], "objectives": [], "vocabulary": [], "phonics": "", "booklet": "", "sightWords": "", "otherSourceRow": ""}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'english_language'
      AND r.folder_type = 'weekly_plans'
      AND COALESCE(r.week_number, 0) = 1
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, semester, week_number, status, uploader_id, description, version)
SELECT '英文语言 - W2 - Welcome to Pre-K', 'English Language - W2 - Welcome to Pre-K',
       'prek', 'montessori', 'english_language', 'weekly_plans',
       'S1', 2, 'published', t.id, '{"weekIndex": 2, "kind": "teaching", "weekLabel": "W2", "dateRange": "Aug 31st–Sept 4th", "calendarNote": "", "theme": "Welcome to Pre-K", "unit": "Introduction & Review", "focus": "Colours", "essentialQuestion": "What colour is it? What colour does red and blue, blue and yellow, red and yellow make?", "storybooks": [{"filePath": "/curriculum-resources/prek-english-covers/1876907126277273.jpg", "title": "Brown Bear, Brown Bear, What Do You See?", "note": ""}, {"filePath": "/curriculum-resources/prek-english-covers/1876907121587203.jpg", "title": "Mouse Paint", "note": ""}], "objectives": ["Be able to recognize and say 4–7 different colors.", "Be able to identify which colours are made by mixing colours together. Begin to understand differences between light and dark colours."], "vocabulary": ["colour", "blue", "yellow", "red", "green", "orange", "purple", "white", "black", "light", "dark"], "phonics": "", "booklet": "", "sightWords": "", "otherSourceRow": ""}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'english_language'
      AND r.folder_type = 'weekly_plans'
      AND COALESCE(r.week_number, 0) = 2
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, semester, week_number, status, uploader_id, description, version)
SELECT '英文语言 - W3 - Welcome to Pre-K', 'English Language - W3 - Welcome to Pre-K',
       'prek', 'montessori', 'english_language', 'weekly_plans',
       'S1', 3, 'published', t.id, '{"weekIndex": 3, "kind": "teaching", "weekLabel": "W3", "dateRange": "Sept 7th–Sept 11th", "calendarNote": "", "theme": "Welcome to Pre-K", "unit": "Introduction & Review", "focus": "Emotions", "essentialQuestion": "How can I recognize and express my feelings in healthy ways?", "storybooks": [{"filePath": "/curriculum-resources/prek-english-covers/1876907125967955.jpg", "title": "The Color Monster", "note": ""}, {"filePath": "/curriculum-resources/prek-english-covers/1876907123995771.jpg", "title": "", "note": "Cover is visible in the source table; title needs verification."}], "objectives": ["How can I recognize and express my feelings in healthy ways?", "Recognize and identify different emotions.", "Learn classroom rules and how to express feelings.", "Use new vocabulary related to emotions in sentences."], "vocabulary": ["Emotions", "happy", "sad", "scared", "excited", "angry", "loved"], "phonics": "", "booklet": "", "sightWords": "", "otherSourceRow": ""}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'english_language'
      AND r.folder_type = 'weekly_plans'
      AND COALESCE(r.week_number, 0) = 3
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, semester, week_number, status, uploader_id, description, version)
SELECT '英文语言 - W4 - Welcome to Pre-K', 'English Language - W4 - Welcome to Pre-K',
       'prek', 'montessori', 'english_language', 'weekly_plans',
       'S1', 4, 'published', t.id, '{"weekIndex": 4, "kind": "teaching", "weekLabel": "W4", "dateRange": "Sept 14th–Sept 18th", "calendarNote": "", "theme": "Welcome to Pre-K", "unit": "Introduction & Review", "focus": "Shapes", "essentialQuestion": "What shapes can you make? What shapes can you find around you?", "storybooks": [{"filePath": "/curriculum-resources/prek-english-covers/1876907128252504.jpg", "title": "Big Box of Shapes", "note": ""}, {"filePath": "/curriculum-resources/prek-english-covers/1876907126392840.jpg", "title": "Shape by Shape", "note": ""}], "objectives": ["Be able to recognize and say shape names.", "Be able to count how many sides shapes have.", "Understand that shapes can be found in all things.", "Be able to identify and point out some shapes in the environment around them."], "vocabulary": ["Square", "triangle", "circle", "rectangle", "diamond", "star", "oval", "heart", "trapezoid", "pentagon", "cube", "cone", "line", "prism", "sphere"], "phonics": "", "booklet": "", "sightWords": "", "otherSourceRow": ""}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'english_language'
      AND r.folder_type = 'weekly_plans'
      AND COALESCE(r.week_number, 0) = 4
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, semester, week_number, status, uploader_id, description, version)
SELECT '英文语言 - W5 - Welcome to Pre-K', 'English Language - W5 - Welcome to Pre-K',
       'prek', 'montessori', 'english_language', 'weekly_plans',
       'S1', 5, 'published', t.id, '{"weekIndex": 5, "kind": "teaching", "weekLabel": "W5", "dateRange": "Sept 21st–Sept 25th", "calendarNote": "", "theme": "Welcome to Pre-K", "unit": "Introduction & Review", "focus": "Numbers", "essentialQuestion": "How do we count the things around us?", "storybooks": [{"filePath": "/curriculum-resources/prek-english-covers/1876907126650888.jpg", "title": "", "note": "Cover is visible in the source table; title needs verification."}, {"filePath": "/curriculum-resources/prek-english-covers/1876907128444011.jpg", "title": "Ten Black Dots", "note": ""}], "objectives": ["Recognise and name numbers from 1 to 10 in English.", "Use question “How many?” during group discussion and activities.", "Count aloud with confidence using real objects and body movements.", "Participate in songs and movement games using #''s."], "vocabulary": ["Numbers: One to Ten", "Question: How many?", "Support Phrases: Let’s count! / There are…"], "phonics": "", "booklet": "", "sightWords": "", "otherSourceRow": ""}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'english_language'
      AND r.folder_type = 'weekly_plans'
      AND COALESCE(r.week_number, 0) = 5
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, semester, week_number, status, uploader_id, description, version)
SELECT '英文语言 - W6 - Welcome to Pre-K', 'English Language - W6 - Welcome to Pre-K',
       'prek', 'montessori', 'english_language', 'weekly_plans',
       'S1', 6, 'published', t.id, '{"weekIndex": 6, "kind": "teaching", "weekLabel": "W6", "dateRange": "Sept 28th–Sept 30th", "calendarNote": "3 Day Week", "theme": "Welcome to Pre-K", "unit": "Introduction & Review", "focus": "Weather", "essentialQuestion": "How is the weather? What is the weather like today?", "storybooks": [{"filePath": "/curriculum-resources/prek-english-covers/1876907132718091.jpg", "title": "Oh, Say Can You Say What''s the Weather Today?", "note": ""}, {"filePath": "/curriculum-resources/prek-english-covers/1876907132096779.jpg", "title": "A Rainbow of My Own", "note": ""}], "objectives": ["Recognise and name common weather and clothing vocabulary."], "vocabulary": ["Weather: sunny", "warm", "rain", "rainy", "windy", "cloudy", "snowy", "hot", "cold"], "phonics": "", "booklet": "", "sightWords": "", "otherSourceRow": ""}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'english_language'
      AND r.folder_type = 'weekly_plans'
      AND COALESCE(r.week_number, 0) = 6
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, semester, week_number, status, uploader_id, description, version)
SELECT '英文语言 - 假期 - Oct 1st–Oct 7th', 'English Language - Holiday - Oct 1st–Oct 7th',
       'prek', 'montessori', 'english_language', 'weekly_plans',
       'S1', 7, 'published', t.id, '{"weekIndex": 7, "kind": "holiday", "weekLabel": "", "dateRange": "Oct 1st–Oct 7th", "calendarNote": "Holiday", "theme": "", "unit": "", "focus": "", "essentialQuestion": "", "storybooks": [], "objectives": [], "vocabulary": [], "phonics": "", "booklet": "", "sightWords": "", "otherSourceRow": ""}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'english_language'
      AND r.folder_type = 'weekly_plans'
      AND COALESCE(r.week_number, 0) = 7
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, semester, week_number, status, uploader_id, description, version)
SELECT '英文语言 - W7 - The Inner World: Understanding Myself', 'English Language - W7 - The Inner World: Understanding Myself',
       'prek', 'montessori', 'english_language', 'weekly_plans',
       'S1', 8, 'published', t.id, '{"weekIndex": 8, "kind": "teaching", "weekLabel": "W7", "dateRange": "Oct 8th–Oct 9th", "calendarNote": "2-Day Week", "theme": "The Inner World: Understanding Myself", "unit": "Unit 1: Myself", "focus": "Clothing", "essentialQuestion": "What do we wear? When do we wear it? How do we put it on?", "storybooks": [{"filePath": "/curriculum-resources/prek-english-covers/1876907128553719.jpg", "title": "Jesse Bear, What Will You Wear?", "note": ""}, {"filePath": "/curriculum-resources/prek-english-covers/1876907129450580.jpg", "title": "Mrs. McNosh Hangs Up Her Wash", "note": ""}], "objectives": ["Explore real clothing through touch, guessing, matching, hanging, dressing and mime.", "Match clothing to suitable weather and explain simple choices.", "Use simple language: “It is ___.” “Today is ___.” “I have a ___.” “I wear ___.” “I’m wearing ___.”"], "vocabulary": ["Clothing: t-shirt", "shorts", "hat", "shoes", "socks", "umbrella", "rain boots", "scarf", "sweater", "jacket", "trousers", "boots"], "phonics": "", "booklet": "", "sightWords": "", "otherSourceRow": ""}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'english_language'
      AND r.folder_type = 'weekly_plans'
      AND COALESCE(r.week_number, 0) = 8
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, semester, week_number, status, uploader_id, description, version)
SELECT '英文语言 - W8 - The Inner World: Understanding Myself', 'English Language - W8 - The Inner World: Understanding Myself',
       'prek', 'montessori', 'english_language', 'weekly_plans',
       'S1', 9, 'published', t.id, '{"weekIndex": 9, "kind": "teaching", "weekLabel": "W8", "dateRange": "Oct 12th–Oct 16th", "calendarNote": "", "theme": "The Inner World: Understanding Myself", "unit": "Unit 1: Myself", "focus": "My Body", "essentialQuestion": "What can we do with our bodies?", "storybooks": [{"filePath": "/curriculum-resources/prek-english-covers/1876907132679175.jpg", "title": "", "note": "Cover is visible in the source table; title needs verification."}, {"filePath": "/curriculum-resources/prek-english-covers/1876907132445700.jpg", "title": "", "note": "Cover is visible in the source table; title needs verification."}], "objectives": [], "vocabulary": [], "phonics": "s", "booklet": "", "sightWords": "", "otherSourceRow": ""}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'english_language'
      AND r.folder_type = 'weekly_plans'
      AND COALESCE(r.week_number, 0) = 9
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, semester, week_number, status, uploader_id, description, version)
SELECT '英文语言 - W9 - The Inner World: Understanding Myself', 'English Language - W9 - The Inner World: Understanding Myself',
       'prek', 'montessori', 'english_language', 'weekly_plans',
       'S1', 10, 'published', t.id, '{"weekIndex": 10, "kind": "teaching", "weekLabel": "W9", "dateRange": "Oct 19th–Oct 23rd", "calendarNote": "", "theme": "The Inner World: Understanding Myself", "unit": "Unit 1: Myself", "focus": "My Senses", "essentialQuestion": "What do our senses help us do?", "storybooks": [{"filePath": "/curriculum-resources/prek-english-covers/1876907130903576.jpg", "title": "", "note": "Cover is visible in the source table; title needs verification."}, {"filePath": "/curriculum-resources/prek-english-covers/1876907138986393.jpg", "title": "It Looked Like Spilt Milk", "note": ""}, {"filePath": "/curriculum-resources/prek-english-covers/1876907138621656.jpg", "title": "Big Smelly Bear", "note": ""}], "objectives": [], "vocabulary": [], "phonics": "a", "booklet": "", "sightWords": "", "otherSourceRow": ""}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'english_language'
      AND r.folder_type = 'weekly_plans'
      AND COALESCE(r.week_number, 0) = 10
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, semester, week_number, status, uploader_id, description, version)
SELECT '英文语言 - W10 - The Inner World: Understanding Myself', 'English Language - W10 - The Inner World: Understanding Myself',
       'prek', 'montessori', 'english_language', 'weekly_plans',
       'S1', 11, 'published', t.id, '{"weekIndex": 11, "kind": "teaching", "weekLabel": "W10", "dateRange": "Oct 26th–Oct 30th", "calendarNote": "", "theme": "The Inner World: Understanding Myself", "unit": "Unit 1: Myself", "focus": "My Family", "essentialQuestion": "What makes a family?", "storybooks": [{"filePath": "/curriculum-resources/prek-english-covers/1876907138082907.jpg", "title": "", "note": "Cover is visible in the source table; title needs verification."}, {"filePath": "/curriculum-resources/prek-english-covers/1876907141039171.jpg", "title": "The Family Book", "note": "Title inferred from cover; please verify against the source book."}, {"filePath": "/curriculum-resources/prek-english-covers/1876907140676667.jpg", "title": "", "note": "Cover is visible in the source table; title needs verification."}], "objectives": [], "vocabulary": [], "phonics": "t", "booklet": "", "sightWords": "", "otherSourceRow": ""}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'english_language'
      AND r.folder_type = 'weekly_plans'
      AND COALESCE(r.week_number, 0) = 11
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, semester, week_number, status, uploader_id, description, version)
SELECT '英文语言 - W11 - The Inner World: Understanding Myself', 'English Language - W11 - The Inner World: Understanding Myself',
       'prek', 'montessori', 'english_language', 'weekly_plans',
       'S1', 12, 'published', t.id, '{"weekIndex": 12, "kind": "teaching", "weekLabel": "W11", "dateRange": "Nov 2nd–Nov 6th", "calendarNote": "", "theme": "The Inner World: Understanding Myself", "unit": "Unit 1: Myself", "focus": "Self-Introduction (Likes & Dislikes)", "essentialQuestion": "", "storybooks": [{"filePath": "/curriculum-resources/prek-english-covers/1876907138522180.jpg", "title": "I Like Me!", "note": "Title inferred from cover; please verify against the source book."}, {"filePath": "/curriculum-resources/prek-english-covers/1876907140333609.jpg", "title": "", "note": "Cover is visible in the source table; title needs verification."}], "objectives": [], "vocabulary": [], "phonics": "p", "booklet": "", "sightWords": "", "otherSourceRow": ""}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'english_language'
      AND r.folder_type = 'weekly_plans'
      AND COALESCE(r.week_number, 0) = 12
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, semester, week_number, status, uploader_id, description, version)
SELECT '英文语言 - W12 - The World Around Us: Our Neighborhood', 'English Language - W12 - The World Around Us: Our Neighborhood',
       'prek', 'montessori', 'english_language', 'weekly_plans',
       'S1', 13, 'published', t.id, '{"weekIndex": 13, "kind": "teaching", "weekLabel": "W12", "dateRange": "Nov 9th–Nov 13th", "calendarNote": "", "theme": "The World Around Us: Our Neighborhood", "unit": "Our Neighborhood", "focus": "Places in My School", "essentialQuestion": "What different places make our school?", "storybooks": [{"filePath": "/curriculum-resources/prek-english-covers/1876907140334745.jpg", "title": "", "note": "Cover is visible in the source table; title needs verification."}, {"filePath": "/curriculum-resources/prek-english-covers/1876907145347498.jpg", "title": "", "note": "Cover is visible in the source table; title needs verification."}], "objectives": ["Be able to recognize and name places in our school.", "Be able to say what we do in the places.", "Understand the rules set in the places.", "Be able to know where the places are located."], "vocabulary": ["Lego Room", "Library", "Gym", "Purple Playground", "Sand Pitch", "Sensory Room", "Football Pitch", "Big slide area", "Forrest"], "phonics": "i", "booklet": "", "sightWords": "", "otherSourceRow": ""}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'english_language'
      AND r.folder_type = 'weekly_plans'
      AND COALESCE(r.week_number, 0) = 13
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, semester, week_number, status, uploader_id, description, version)
SELECT '英文语言 - W13 - The World Around Us: Our Neighborhood', 'English Language - W13 - The World Around Us: Our Neighborhood',
       'prek', 'montessori', 'english_language', 'weekly_plans',
       'S1', 14, 'published', t.id, '{"weekIndex": 14, "kind": "teaching", "weekLabel": "W13", "dateRange": "Nov 16th–Nov 20th", "calendarNote": "", "theme": "The World Around Us: Our Neighborhood", "unit": "Our Neighborhood", "focus": "Places in My Community", "essentialQuestion": "What different places make our community?", "storybooks": [], "objectives": [], "vocabulary": [], "phonics": "n", "booklet": "", "sightWords": "", "otherSourceRow": ""}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'english_language'
      AND r.folder_type = 'weekly_plans'
      AND COALESCE(r.week_number, 0) = 14
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, semester, week_number, status, uploader_id, description, version)
SELECT '英文语言 - W14 - The World Around Us: Our Neighborhood', 'English Language - W14 - The World Around Us: Our Neighborhood',
       'prek', 'montessori', 'english_language', 'weekly_plans',
       'S1', 15, 'published', t.id, '{"weekIndex": 15, "kind": "teaching", "weekLabel": "W14", "dateRange": "Nov 23rd–Nov 27th", "calendarNote": "", "theme": "The World Around Us: Our Neighborhood", "unit": "Our Neighborhood", "focus": "People in My Community", "essentialQuestion": "Who are the people in our community?", "storybooks": [{"filePath": "/curriculum-resources/prek-english-covers/1876907146826951.jpg", "title": "", "note": "Cover is visible in the source table; title needs verification."}, {"filePath": "/curriculum-resources/prek-english-covers/1876907142300692.jpg", "title": "Busytown", "note": "Title inferred from cover; please verify against the source book."}], "objectives": [], "vocabulary": [], "phonics": "s a t p i n Review", "booklet": "", "sightWords": "", "otherSourceRow": ""}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'english_language'
      AND r.folder_type = 'weekly_plans'
      AND COALESCE(r.week_number, 0) = 15
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, semester, week_number, status, uploader_id, description, version)
SELECT '英文语言 - W15 - The World Around Us: Our Neighborhood', 'English Language - W15 - The World Around Us: Our Neighborhood',
       'prek', 'montessori', 'english_language', 'weekly_plans',
       'S1', 16, 'published', t.id, '{"weekIndex": 16, "kind": "teaching", "weekLabel": "W15", "dateRange": "Nov 30th–Dec 4th", "calendarNote": "", "theme": "The World Around Us: Our Neighborhood", "unit": "Our Neighborhood", "focus": "People in My Community", "essentialQuestion": "Who are the people in our community?", "storybooks": [{"filePath": "/curriculum-resources/prek-english-covers/1876907146829047.jpg", "title": "", "note": "Cover is visible in the source table; title needs verification."}, {"filePath": "/curriculum-resources/prek-english-covers/1876907146901592.jpg", "title": "", "note": "Cover is visible in the source table; title needs verification."}], "objectives": [], "vocabulary": [], "phonics": "m", "booklet": "", "sightWords": "", "otherSourceRow": ""}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'english_language'
      AND r.folder_type = 'weekly_plans'
      AND COALESCE(r.week_number, 0) = 16
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, semester, week_number, status, uploader_id, description, version)
SELECT '英文语言 - W16 - The World Around Us: Our Neighborhood', 'English Language - W16 - The World Around Us: Our Neighborhood',
       'prek', 'montessori', 'english_language', 'weekly_plans',
       'S1', 17, 'published', t.id, '{"weekIndex": 17, "kind": "teaching", "weekLabel": "W16", "dateRange": "Dec 7th–Dec 11th", "calendarNote": "", "theme": "The World Around Us: Our Neighborhood", "unit": "Our Neighborhood", "focus": "People in My Community", "essentialQuestion": "Who are the people in our community?", "storybooks": [{"filePath": "/curriculum-resources/prek-english-covers/1876907151217785.jpg", "title": "", "note": "Cover is visible in the source table; title needs verification."}, {"filePath": "/curriculum-resources/prek-english-covers/1876907149442490.jpg", "title": "", "note": "Cover is visible in the source table; title needs verification."}], "objectives": [], "vocabulary": [], "phonics": "d", "booklet": "", "sightWords": "", "otherSourceRow": ""}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'english_language'
      AND r.folder_type = 'weekly_plans'
      AND COALESCE(r.week_number, 0) = 17
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, semester, week_number, status, uploader_id, description, version)
SELECT '英文语言 - W17 - The World Around Us: Our Neighborhood', 'English Language - W17 - The World Around Us: Our Neighborhood',
       'prek', 'montessori', 'english_language', 'weekly_plans',
       'S1', 18, 'published', t.id, '{"weekIndex": 18, "kind": "teaching", "weekLabel": "W17", "dateRange": "Dec 14th–Dec 18th", "calendarNote": "", "theme": "The World Around Us: Our Neighborhood", "unit": "Our Neighborhood", "focus": "Christmas Week", "essentialQuestion": "How can we help in our community?", "storybooks": [], "objectives": [], "vocabulary": [], "phonics": "", "booklet": "", "sightWords": "", "otherSourceRow": ""}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'english_language'
      AND r.folder_type = 'weekly_plans'
      AND COALESCE(r.week_number, 0) = 18
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, semester, week_number, status, uploader_id, description, version)
SELECT '英文语言 - 假期 - Dec 19th–Jan 4th', 'English Language - Holiday - Dec 19th–Jan 4th',
       'prek', 'montessori', 'english_language', 'weekly_plans',
       'S1', 19, 'published', t.id, '{"weekIndex": 19, "kind": "holiday", "weekLabel": "", "dateRange": "Dec 19th–Jan 4th", "calendarNote": "Holiday", "theme": "", "unit": "", "focus": "", "essentialQuestion": "", "storybooks": [], "objectives": [], "vocabulary": [], "phonics": "", "booklet": "", "sightWords": "", "otherSourceRow": ""}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'english_language'
      AND r.folder_type = 'weekly_plans'
      AND COALESCE(r.week_number, 0) = 19
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, semester, week_number, status, uploader_id, description, version)
SELECT '英文语言 - W18 - The World Around Us: Our Neighborhood', 'English Language - W18 - The World Around Us: Our Neighborhood',
       'prek', 'montessori', 'english_language', 'weekly_plans',
       'S1', 20, 'published', t.id, '{"weekIndex": 20, "kind": "teaching", "weekLabel": "W18", "dateRange": "Jan 4th–Jan 8th", "calendarNote": "", "theme": "The World Around Us: Our Neighborhood", "unit": "Transportation", "focus": "Different Modes of Transport", "essentialQuestion": "How do we get around our neighbourhood?", "storybooks": [{"filePath": "/curriculum-resources/prek-english-covers/1876907148954708.jpg", "title": "The Bus for Us", "note": "Title inferred from cover; please verify against the source book."}, {"filePath": "/curriculum-resources/prek-english-covers/1876907148741924.jpg", "title": "", "note": "Cover is visible in the source table; title needs verification."}], "objectives": [], "vocabulary": [], "phonics": "g o", "booklet": "", "sightWords": "", "otherSourceRow": ""}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'english_language'
      AND r.folder_type = 'weekly_plans'
      AND COALESCE(r.week_number, 0) = 20
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, semester, week_number, status, uploader_id, description, version)
SELECT '英文语言 - W19 - The World Around Us: Our Neighborhood', 'English Language - W19 - The World Around Us: Our Neighborhood',
       'prek', 'montessori', 'english_language', 'weekly_plans',
       'S1', 21, 'published', t.id, '{"weekIndex": 21, "kind": "teaching", "weekLabel": "W19", "dateRange": "Jan 11th–Jan 15th", "calendarNote": "", "theme": "The World Around Us: Our Neighborhood", "unit": "Transportation", "focus": "Different Modes of Transport", "essentialQuestion": "How do we get around our neighbourhood?", "storybooks": [{"filePath": "/curriculum-resources/prek-english-covers/1876907152629915.jpg", "title": "Excavator’s 123", "note": "Title is partly legible on the source cover; please verify."}, {"filePath": "/curriculum-resources/prek-english-covers/1876907156475001.jpg", "title": "", "note": "Cover is visible in the source table; title needs verification."}], "objectives": [], "vocabulary": [], "phonics": "m d g o c k Review", "booklet": "", "sightWords": "", "otherSourceRow": ""}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'english_language'
      AND r.folder_type = 'weekly_plans'
      AND COALESCE(r.week_number, 0) = 21
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, semester, week_number, status, uploader_id, description, version)
SELECT '英文语言 - W20 - Spring Festival', 'English Language - W20 - Spring Festival',
       'prek', 'montessori', 'english_language', 'weekly_plans',
       'S1', 22, 'published', t.id, '{"weekIndex": 22, "kind": "teaching", "weekLabel": "W20", "dateRange": "Jan 18th–Jan 22nd", "calendarNote": "", "theme": "Spring Festival", "unit": "Chinese New Year (CNY) Celebration", "focus": "Chinese Traditions", "essentialQuestion": "", "storybooks": [], "objectives": [], "vocabulary": [], "phonics": "", "booklet": "1 Cat on the Mat", "sightWords": "", "otherSourceRow": ""}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'english_language'
      AND r.folder_type = 'weekly_plans'
      AND COALESCE(r.week_number, 0) = 22
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, semester, week_number, status, uploader_id, description, version)
SELECT '英文语言 - W21 - Spring Festival', 'English Language - W21 - Spring Festival',
       'prek', 'montessori', 'english_language', 'weekly_plans',
       'S1', 23, 'published', t.id, '{"weekIndex": 23, "kind": "teaching", "weekLabel": "W21", "dateRange": "Jan 25th–Jan 29th", "calendarNote": "", "theme": "Spring Festival", "unit": "Chinese New Year (CNY) Celebration", "focus": "Zodiac Race", "essentialQuestion": "", "storybooks": [], "objectives": [], "vocabulary": [], "phonics": "", "booklet": "2 Dan and a Van", "sightWords": "", "otherSourceRow": ""}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'english_language'
      AND r.folder_type = 'weekly_plans'
      AND COALESCE(r.week_number, 0) = 23
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, semester, week_number, status, uploader_id, description, version)
SELECT '英文语言 - 假期 - Jan 30th–Feb 16th', 'English Language - Holiday - Jan 30th–Feb 16th',
       'prek', 'montessori', 'english_language', 'weekly_plans',
       'S1', 24, 'published', t.id, '{"weekIndex": 24, "kind": "holiday", "weekLabel": "", "dateRange": "Jan 30th–Feb 16th", "calendarNote": "Feb 16th = Preparation Day", "theme": "", "unit": "", "focus": "", "essentialQuestion": "", "storybooks": [], "objectives": [], "vocabulary": [], "phonics": "", "booklet": "", "sightWords": "", "otherSourceRow": ""}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'english_language'
      AND r.folder_type = 'weekly_plans'
      AND COALESCE(r.week_number, 0) = 24
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, semester, week_number, status, uploader_id, description, version)
SELECT '英文语言 - W1', 'English Language - W1',
       'prek', 'montessori', 'english_language', 'weekly_plans',
       'S2', 25, 'published', t.id, '{"weekIndex": 25, "kind": "teaching", "weekLabel": "W1", "dateRange": "Feb 17th–Feb 19th", "calendarNote": "3 Day Week", "theme": "", "unit": "", "focus": "", "essentialQuestion": "", "storybooks": [], "objectives": [], "vocabulary": [], "phonics": "", "booklet": "3 The Lad", "sightWords": "", "otherSourceRow": ""}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'english_language'
      AND r.folder_type = 'weekly_plans'
      AND COALESCE(r.week_number, 0) = 25
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, semester, week_number, status, uploader_id, description, version)
SELECT '英文语言 - W2', 'English Language - W2',
       'prek', 'montessori', 'english_language', 'weekly_plans',
       'S2', 26, 'published', t.id, '{"weekIndex": 26, "kind": "teaching", "weekLabel": "W2", "dateRange": "Feb 22nd–Feb 26th", "calendarNote": "", "theme": "", "unit": "Plants: Botany", "focus": "Parts of a Plant", "essentialQuestion": "", "storybooks": [], "objectives": [], "vocabulary": [], "phonics": "", "booklet": "4 Dan and His Cap", "sightWords": "", "otherSourceRow": ""}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'english_language'
      AND r.folder_type = 'weekly_plans'
      AND COALESCE(r.week_number, 0) = 26
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, semester, week_number, status, uploader_id, description, version)
SELECT '英文语言 - W3', 'English Language - W3',
       'prek', 'montessori', 'english_language', 'weekly_plans',
       'S2', 27, 'published', t.id, '{"weekIndex": 27, "kind": "teaching", "weekLabel": "W3", "dateRange": "Mar 1st–Mar 5th", "calendarNote": "", "theme": "", "unit": "Plants: Botany", "focus": "Plant Life-Cycle", "essentialQuestion": "What do plants need to live and grow?", "storybooks": [], "objectives": [], "vocabulary": [], "phonics": "", "booklet": "5 The Pet in a Jet", "sightWords": "", "otherSourceRow": ""}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'english_language'
      AND r.folder_type = 'weekly_plans'
      AND COALESCE(r.week_number, 0) = 27
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, semester, week_number, status, uploader_id, description, version)
SELECT '英文语言 - W4', 'English Language - W4',
       'prek', 'montessori', 'english_language', 'weekly_plans',
       'S2', 28, 'published', t.id, '{"weekIndex": 28, "kind": "teaching", "weekLabel": "W4", "dateRange": "Mar 8th–Mar 12th", "calendarNote": "", "theme": "", "unit": "Plants: Botany", "focus": "Needs of a Plant", "essentialQuestion": "What do plants need to live and grow?", "storybooks": [], "objectives": [], "vocabulary": [], "phonics": "", "booklet": "6 The Hen in a Pen", "sightWords": "", "otherSourceRow": ""}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'english_language'
      AND r.folder_type = 'weekly_plans'
      AND COALESCE(r.week_number, 0) = 28
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, semester, week_number, status, uploader_id, description, version)
SELECT '英文语言 - W5 - The Food We Eat', 'English Language - W5 - The Food We Eat',
       'prek', 'montessori', 'english_language', 'weekly_plans',
       'S2', 29, 'published', t.id, '{"weekIndex": 29, "kind": "teaching", "weekLabel": "W5", "dateRange": "Mar 15th–Mar 19th", "calendarNote": "", "theme": "The Food We Eat", "unit": "The Food We Eat", "focus": "Where Food Comes From", "essentialQuestion": "", "storybooks": [], "objectives": [], "vocabulary": [], "phonics": "", "booklet": "7 Pip the Pup", "sightWords": "", "otherSourceRow": ""}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'english_language'
      AND r.folder_type = 'weekly_plans'
      AND COALESCE(r.week_number, 0) = 29
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, semester, week_number, status, uploader_id, description, version)
SELECT '英文语言 - W6 - The Food We Eat', 'English Language - W6 - The Food We Eat',
       'prek', 'montessori', 'english_language', 'weekly_plans',
       'S2', 30, 'published', t.id, '{"weekIndex": 30, "kind": "teaching", "weekLabel": "W6", "dateRange": "Mar 22nd–Mar 25th", "calendarNote": "4 Day Week; Mar 26th = PD Day", "theme": "The Food We Eat", "unit": "The Food We Eat", "focus": "Healthy Diet", "essentialQuestion": "How can we choose healthy food to eat?", "storybooks": [], "objectives": [], "vocabulary": [], "phonics": "", "booklet": "8 The Kid and a Pig", "sightWords": "", "otherSourceRow": ""}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'english_language'
      AND r.folder_type = 'weekly_plans'
      AND COALESCE(r.week_number, 0) = 30
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, semester, week_number, status, uploader_id, description, version)
SELECT '英文语言 - W7 - The Food We Eat', 'English Language - W7 - The Food We Eat',
       'prek', 'montessori', 'english_language', 'weekly_plans',
       'S2', 31, 'published', t.id, '{"weekIndex": 31, "kind": "teaching", "weekLabel": "W7", "dateRange": "Mar 29th–Apr 2nd", "calendarNote": "Apr 5th = Tomb Sweeping", "theme": "The Food We Eat", "unit": "The Food We Eat", "focus": "What We Eat", "essentialQuestion": "What food did the caterpillar eat?", "storybooks": [], "objectives": [], "vocabulary": [], "phonics": "", "booklet": "9 The Tin Bin", "sightWords": "", "otherSourceRow": ""}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'english_language'
      AND r.folder_type = 'weekly_plans'
      AND COALESCE(r.week_number, 0) = 31
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, semester, week_number, status, uploader_id, description, version)
SELECT '英文语言 - W8 - The Natural World: Understanding Nature', 'English Language - W8 - The Natural World: Understanding Nature',
       'prek', 'montessori', 'english_language', 'weekly_plans',
       'S2', 32, 'published', t.id, '{"weekIndex": 32, "kind": "teaching", "weekLabel": "W8", "dateRange": "Apr 6th–Apr 9th", "calendarNote": "", "theme": "The Natural World: Understanding Nature", "unit": "Natural Ecosystems", "focus": "Habitats", "essentialQuestion": "What different habitats do animals live in?", "storybooks": [], "objectives": [], "vocabulary": [], "phonics": "", "booklet": "10 The Dog in the Well", "sightWords": "", "otherSourceRow": ""}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'english_language'
      AND r.folder_type = 'weekly_plans'
      AND COALESCE(r.week_number, 0) = 32
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, semester, week_number, status, uploader_id, description, version)
SELECT '英文语言 - W9 - The Natural World: Understanding Nature', 'English Language - W9 - The Natural World: Understanding Nature',
       'prek', 'montessori', 'english_language', 'weekly_plans',
       'S2', 33, 'published', t.id, '{"weekIndex": 33, "kind": "teaching", "weekLabel": "W9", "dateRange": "Apr 12th–Apr 16th", "calendarNote": "", "theme": "The Natural World: Understanding Nature", "unit": "Natural Ecosystems", "focus": "Habitats", "essentialQuestion": "What different habitats do animals live in?", "storybooks": [], "objectives": [], "vocabulary": [], "phonics": "", "booklet": "11 Will is Ill", "sightWords": "", "otherSourceRow": ""}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'english_language'
      AND r.folder_type = 'weekly_plans'
      AND COALESCE(r.week_number, 0) = 33
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, semester, week_number, status, uploader_id, description, version)
SELECT '英文语言 - W10', 'English Language - W10',
       'prek', 'montessori', 'english_language', 'weekly_plans',
       'S2', 34, 'published', t.id, '{"weekIndex": 34, "kind": "teaching", "weekLabel": "W10", "dateRange": "Apr 19th–Apr 23rd", "calendarNote": "Apr 19th–22nd = Observation Week; Apr 23rd–24th = One-to-One Parents Meetings", "theme": "", "unit": "Wild Animals", "focus": "Wild Animals", "essentialQuestion": "What animals can we find outside?", "storybooks": [], "objectives": [], "vocabulary": [], "phonics": "", "booklet": "12 Pop and His Pot", "sightWords": "", "otherSourceRow": ""}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'english_language'
      AND r.folder_type = 'weekly_plans'
      AND COALESCE(r.week_number, 0) = 34
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, semester, week_number, status, uploader_id, description, version)
SELECT '英文语言 - W11', 'English Language - W11',
       'prek', 'montessori', 'english_language', 'weekly_plans',
       'S2', 35, 'published', t.id, '{"weekIndex": 35, "kind": "teaching", "weekLabel": "W11", "dateRange": "Apr 26th–Apr 29th", "calendarNote": "4-Day Week; Apr 30th–May 4th = Labor Day Holiday", "theme": "", "unit": "Animals: Zoology", "focus": "Farm", "essentialQuestion": "What animals live on the farm?", "storybooks": [], "objectives": [], "vocabulary": [], "phonics": "", "booklet": "13. Hog and the Dog", "sightWords": "", "otherSourceRow": ""}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'english_language'
      AND r.folder_type = 'weekly_plans'
      AND COALESCE(r.week_number, 0) = 35
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, semester, week_number, status, uploader_id, description, version)
SELECT '英文语言 - W12', 'English Language - W12',
       'prek', 'montessori', 'english_language', 'weekly_plans',
       'S2', 36, 'published', t.id, '{"weekIndex": 36, "kind": "teaching", "weekLabel": "W12", "dateRange": "May 5th–May 7th", "calendarNote": "3 Day Week", "theme": "", "unit": "Animals: Zoology", "focus": "Pets", "essentialQuestion": "What animals live in our home?", "storybooks": [], "objectives": [], "vocabulary": [], "phonics": "", "booklet": "14 A Bug in the Mud", "sightWords": "", "otherSourceRow": ""}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'english_language'
      AND r.folder_type = 'weekly_plans'
      AND COALESCE(r.week_number, 0) = 36
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, semester, week_number, status, uploader_id, description, version)
SELECT '英文语言 - W13', 'English Language - W13',
       'prek', 'montessori', 'english_language', 'weekly_plans',
       'S2', 37, 'published', t.id, '{"weekIndex": 37, "kind": "teaching", "weekLabel": "W13", "dateRange": "May 10th–May 14th", "calendarNote": "", "theme": "", "unit": "", "focus": "", "essentialQuestion": "", "storybooks": [], "objectives": [], "vocabulary": [], "phonics": "", "booklet": "15 Pets are Fun", "sightWords": "", "otherSourceRow": ""}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'english_language'
      AND r.folder_type = 'weekly_plans'
      AND COALESCE(r.week_number, 0) = 37
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, semester, week_number, status, uploader_id, description, version)
SELECT '英文语言 - W14', 'English Language - W14',
       'prek', 'montessori', 'english_language', 'weekly_plans',
       'S2', 38, 'published', t.id, '{"weekIndex": 38, "kind": "teaching", "weekLabel": "W14", "dateRange": "May 17th–May 21st", "calendarNote": "May 21st = Xiao Man Poetry Conference", "theme": "", "unit": "", "focus": "", "essentialQuestion": "", "storybooks": [], "objectives": [], "vocabulary": [], "phonics": "", "booklet": "16 Jay Can Play", "sightWords": "", "otherSourceRow": ""}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'english_language'
      AND r.folder_type = 'weekly_plans'
      AND COALESCE(r.week_number, 0) = 38
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, semester, week_number, status, uploader_id, description, version)
SELECT '英文语言 - W15 - The Wider World: Our Planet', 'English Language - W15 - The Wider World: Our Planet',
       'prek', 'montessori', 'english_language', 'weekly_plans',
       'S2', 39, 'published', t.id, '{"weekIndex": 39, "kind": "teaching", "weekLabel": "W15", "dateRange": "May 24th–May 28th", "calendarNote": "", "theme": "The Wider World: Our Planet", "unit": "Countries & Continents", "focus": "", "essentialQuestion": "", "storybooks": [], "objectives": [], "vocabulary": [], "phonics": "", "booklet": "17 Dan and the Bee", "sightWords": "", "otherSourceRow": ""}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'english_language'
      AND r.folder_type = 'weekly_plans'
      AND COALESCE(r.week_number, 0) = 39
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, semester, week_number, status, uploader_id, description, version)
SELECT '英文语言 - W16 - The Wider World: Our Planet', 'English Language - W16 - The Wider World: Our Planet',
       'prek', 'montessori', 'english_language', 'weekly_plans',
       'S2', 40, 'published', t.id, '{"weekIndex": 40, "kind": "teaching", "weekLabel": "W16", "dateRange": "May 31st–Jun 4th", "calendarNote": "June 1st = Children''s Day Events", "theme": "The Wider World: Our Planet", "unit": "Countries & Continents", "focus": "", "essentialQuestion": "", "storybooks": [], "objectives": [], "vocabulary": [], "phonics": "", "booklet": "18 The Fox in the Box", "sightWords": "", "otherSourceRow": ""}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'english_language'
      AND r.folder_type = 'weekly_plans'
      AND COALESCE(r.week_number, 0) = 40
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, semester, week_number, status, uploader_id, description, version)
SELECT '英文语言 - W17 - The Wider World: Our Planet', 'English Language - W17 - The Wider World: Our Planet',
       'prek', 'montessori', 'english_language', 'weekly_plans',
       'S2', 41, 'published', t.id, '{"weekIndex": 41, "kind": "teaching", "weekLabel": "W17", "dateRange": "Jun 7th–Jun 11th", "calendarNote": "Source week label is blank; ordered as S2 W17 by date sequence.", "theme": "The Wider World: Our Planet", "unit": "Countries & Continents", "focus": "", "essentialQuestion": "", "storybooks": [], "objectives": [], "vocabulary": [], "phonics": "", "booklet": "19 Jow Had to Mow (source spells “Jow”; needs verification)", "sightWords": "", "otherSourceRow": ""}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'english_language'
      AND r.folder_type = 'weekly_plans'
      AND COALESCE(r.week_number, 0) = 41
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, semester, week_number, status, uploader_id, description, version)
SELECT '英文语言 - W18 - The Wider World: Our Planet', 'English Language - W18 - The Wider World: Our Planet',
       'prek', 'montessori', 'english_language', 'weekly_plans',
       'S2', 42, 'published', t.id, '{"weekIndex": 42, "kind": "teaching", "weekLabel": "W18", "dateRange": "Jun 14th–Jun 18th", "calendarNote": "Jun 17th–18th = Graduation; Jun 19th = Wrapping Up Day. Source week label is blank; ordered as S2 W18 by date sequence.", "theme": "The Wider World: Our Planet", "unit": "Countries & Continents", "focus": "", "essentialQuestion": "", "storybooks": [], "objectives": [], "vocabulary": [], "phonics": "", "booklet": "20 ____ (source title is clipped / not legible; to be completed)", "sightWords": "", "otherSourceRow": ""}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'english_language'
      AND r.folder_type = 'weekly_plans'
      AND COALESCE(r.week_number, 0) = 42
  );


-- ============================================================
-- 4. Pre-K 蒙特梭利非英文区 - 工作项 (courseware 课件与示范)
-- 日常生活 79 + 感官 32 + 数学 36 + 文化 98 = 245 项
-- ============================================================

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '寻求关注', 'Drawing one''s attention',
       'prek', 'montessori', 'practical_life', 'courseware',
       '优雅与礼仪', 'published', t.id, '{"category": "优雅与礼仪", "categoryEn": "Grace and Courtesy", "itemType": "routine", "itemIndex": 1, "title": "寻求关注", "titleEn": "Drawing one''s attention", "slide": null, "age": "2.5", "aim": "", "aimEn": "", "language": "打扰一下；我需要帮助；谢谢", "languageEn": "Excuse me;I need help;Thank you!"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'practical_life'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '优雅与礼仪'
      AND r.title = '寻求关注'
      AND r.description::json->>'itemIndex' = '1'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '观察工作', 'Observing Someone''s Work',
       'prek', 'montessori', 'practical_life', 'courseware',
       '优雅与礼仪', 'published', t.id, '{"category": "优雅与礼仪", "categoryEn": "Grace and Courtesy", "itemType": "routine", "itemIndex": 2, "title": "观察工作", "titleEn": "Observing Someone''s Work", "slide": null, "age": "2.5", "aim": "", "aimEn": "", "language": "打扰一下；我可以观察你工作吗；也许下一次", "languageEn": "Excuse me; May I watch your work; Maybe another time"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'practical_life'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '优雅与礼仪'
      AND r.title = '观察工作'
      AND r.description::json->>'itemIndex' = '2'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '请求 / 给予帮助', 'Offering and Giving Help',
       'prek', 'montessori', 'practical_life', 'courseware',
       '优雅与礼仪', 'published', t.id, '{"category": "优雅与礼仪", "categoryEn": "Grace and Courtesy", "itemType": "routine", "itemIndex": 3, "title": "请求 / 给予帮助", "titleEn": "Offering and Giving Help", "slide": null, "age": "2.5", "aim": "", "aimEn": "", "language": "我可以帮助你吗", "languageEn": "Can I help you?"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'practical_life'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '优雅与礼仪'
      AND r.title = '请求 / 给予帮助'
      AND r.description::json->>'itemIndex' = '3'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '打扰一下', 'Excuse me',
       'prek', 'montessori', 'practical_life', 'courseware',
       '优雅与礼仪', 'published', t.id, '{"category": "优雅与礼仪", "categoryEn": "Grace and Courtesy", "itemType": "routine", "itemIndex": 4, "title": "打扰一下", "titleEn": "Excuse me", "slide": null, "age": "2.5", "aim": "", "aimEn": "", "language": "打扰一下", "languageEn": "—"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'practical_life'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '优雅与礼仪'
      AND r.title = '打扰一下'
      AND r.description::json->>'itemIndex' = '4'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '请和谢谢', 'Please and Thank you',
       'prek', 'montessori', 'practical_life', 'courseware',
       '优雅与礼仪', 'published', t.id, '{"category": "优雅与礼仪", "categoryEn": "Grace and Courtesy", "itemType": "routine", "itemIndex": 5, "title": "请和谢谢", "titleEn": "Please and Thank you", "slide": null, "age": "2.5", "aim": "", "aimEn": "", "language": "请；谢谢", "languageEn": "—"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'practical_life'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '优雅与礼仪'
      AND r.title = '请和谢谢'
      AND r.description::json->>'itemIndex' = '5'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '问候和告别', 'Greeting and Saying Goodbye',
       'prek', 'montessori', 'practical_life', 'courseware',
       '优雅与礼仪', 'published', t.id, '{"category": "优雅与礼仪", "categoryEn": "Grace and Courtesy", "itemType": "routine", "itemIndex": 6, "title": "问候和告别", "titleEn": "Greeting and Saying Goodbye", "slide": null, "age": "3", "aim": "", "aimEn": "", "language": "早上好；再见；明天见；下周见", "languageEn": "Good morning;Can you say goodmorning; Goodbye;See you tomorrow;See you next week!"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'practical_life'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '优雅与礼仪'
      AND r.title = '问候和告别'
      AND r.description::json->>'itemIndex' = '6'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '轻缓行走', 'Walking in the classroom',
       'prek', 'montessori', 'practical_life', 'courseware',
       '大动作技能', 'published', t.id, '{"category": "大动作技能", "categoryEn": "Gross Motor Skills", "itemType": "routine", "itemIndex": 1, "title": "轻缓行走", "titleEn": "Walking in the classroom", "slide": null, "age": "2.5", "aim": "", "aimEn": "", "language": "请慢慢/小心地走", "languageEn": "Please walk slowly/carefully"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'practical_life'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '大动作技能'
      AND r.title = '轻缓行走'
      AND r.description::json->>'itemIndex' = '1'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '走线', 'Walking on the line',
       'prek', 'montessori', 'practical_life', 'courseware',
       '大动作技能', 'published', t.id, '{"category": "大动作技能", "categoryEn": "Gross Motor Skills", "itemType": "routine", "itemIndex": 2, "title": "走线", "titleEn": "Walking on the line", "slide": null, "age": "3.5", "aim": "", "aimEn": "", "language": "走线；脚在线上；保持距离", "languageEn": "Walking on the line;Feet on the line;Keep distance"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'practical_life'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '大动作技能'
      AND r.title = '走线'
      AND r.description::json->>'itemIndex' = '2'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '坐在线上', 'Sitting on the circle',
       'prek', 'montessori', 'practical_life', 'courseware',
       '大动作技能', 'published', t.id, '{"category": "大动作技能", "categoryEn": "Gross Motor Skills", "itemType": "routine", "itemIndex": 3, "title": "坐在线上", "titleEn": "Sitting on the circle", "slide": null, "age": "3.5", "aim": "", "aimEn": "", "language": "坐下；起立；盘腿坐", "languageEn": "Sit down;Stand up;Crisscross applesause"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'practical_life'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '大动作技能'
      AND r.title = '坐在线上'
      AND r.description::json->>'itemIndex' = '3'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '开关门', 'Opening and shutting a door',
       'prek', 'montessori', 'practical_life', 'courseware',
       '大动作技能', 'published', t.id, '{"category": "大动作技能", "categoryEn": "Gross Motor Skills", "itemType": "routine", "itemIndex": 4, "title": "开关门", "titleEn": "Opening and shutting a door", "slide": null, "age": "3.5", "aim": "", "aimEn": "", "language": "开/关门；推/拉", "languageEn": "Open;Close the door;Push/Pull"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'practical_life'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '大动作技能'
      AND r.title = '开关门'
      AND r.description::json->>'itemIndex' = '4'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '拿取托盘', 'Carrying a tray',
       'prek', 'montessori', 'practical_life', 'courseware',
       '大动作技能', 'published', t.id, '{"category": "大动作技能", "categoryEn": "Gross Motor Skills", "itemType": "routine", "itemIndex": 5, "title": "拿取托盘", "titleEn": "Carrying a tray", "slide": null, "age": "1.5–3", "aim": "", "aimEn": "", "language": "拿起托盘；放在桌/垫子上；放回柜子上", "languageEn": "Pick up the tray;Put it on the table/mat;Put it back to the shelf"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'practical_life'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '大动作技能'
      AND r.title = '拿取托盘'
      AND r.description::json->>'itemIndex' = '5'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '使用工作毯', 'Using a mat',
       'prek', 'montessori', 'practical_life', 'courseware',
       '大动作技能', 'published', t.id, '{"category": "大动作技能", "categoryEn": "Gross Motor Skills", "itemType": "routine", "itemIndex": 6, "title": "使用工作毯", "titleEn": "Using a mat", "slide": null, "age": "2.5", "aim": "", "aimEn": "", "language": "打开/卷起工作毯；平铺", "languageEn": "Unroll/Roll the mat;Flat"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'practical_life'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '大动作技能'
      AND r.title = '使用工作毯'
      AND r.description::json->>'itemIndex' = '6'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '使用椅子', 'Using a chair',
       'prek', 'montessori', 'practical_life', 'courseware',
       '大动作技能', 'published', t.id, '{"category": "大动作技能", "categoryEn": "Gross Motor Skills", "itemType": "routine", "itemIndex": 7, "title": "使用椅子", "titleEn": "Using a chair", "slide": null, "age": "3", "aim": "", "aimEn": "", "language": "拉出来；推进去；拿起来；搬椅子；移动", "languageEn": "Pull out;Push in; Pick it up;Carry a chair;Move"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'practical_life'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '大动作技能'
      AND r.title = '使用椅子'
      AND r.description::json->>'itemIndex' = '7'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '搬桌子', 'Carrying a table',
       'prek', 'montessori', 'practical_life', 'courseware',
       '大动作技能', 'published', t.id, '{"category": "大动作技能", "categoryEn": "Gross Motor Skills", "itemType": "routine", "itemIndex": 8, "title": "搬桌子", "titleEn": "Carrying a table", "slide": null, "age": "3.5", "aim": "", "aimEn": "", "language": "1、2、3；抬起来", "languageEn": "One,two,three;Lift up"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'practical_life'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '大动作技能'
      AND r.title = '搬桌子'
      AND r.description::json->>'itemIndex' = '8'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '拿尖锐物品', 'Handing sharp objects',
       'prek', 'montessori', 'practical_life', 'courseware',
       '大动作技能', 'published', t.id, '{"category": "大动作技能", "categoryEn": "Gross Motor Skills", "itemType": "routine", "itemIndex": 9, "title": "拿尖锐物品", "titleEn": "Handing sharp objects", "slide": null, "age": "3.5", "aim": "", "aimEn": "", "language": "剪刀；安全地拿剪刀", "languageEn": "Scissors;carry scissors safely"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'practical_life'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '大动作技能'
      AND r.title = '拿尖锐物品'
      AND r.description::json->>'itemIndex' = '9'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '捧', 'Hand Scooping',
       'prek', 'montessori', 'practical_life', 'courseware',
       '精细动作：基础动作', 'published', t.id, '{"category": "精细动作：基础动作", "categoryEn": "精细动作：基础动作 Fine Motor Skills", "itemType": "lesson", "itemIndex": 1, "title": "捧", "titleEn": "Hand Scooping", "slide": 15, "age": "3", "aim": "发展幼儿专注力，协调性，独立性，有序性", "aimEn": "Control & coordination of movement, concentration, independence, sense of order", "language": "双手捧", "languageEn": "Carrying with two hands"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'practical_life'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '精细动作：基础动作'
      AND r.title = '捧'
      AND r.description::json->>'itemIndex' = '1'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '五指抓', 'Grasping Transfer',
       'prek', 'montessori', 'practical_life', 'courseware',
       '精细动作：基础动作', 'published', t.id, '{"category": "精细动作：基础动作", "categoryEn": "精细动作：基础动作 Fine Motor Skills", "itemType": "lesson", "itemIndex": 2, "title": "五指抓", "titleEn": "Grasping Transfer", "slide": 17, "age": "3", "aim": "发展幼儿专注力，协调性，独立性，有序性", "aimEn": "Control & coordination of movement, concentration, independence, sense of order", "language": "抓起来，空，满", "languageEn": "Grab, empty, filled"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'practical_life'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '精细动作：基础动作'
      AND r.title = '五指抓'
      AND r.description::json->>'itemIndex' = '2'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '开关', 'Containers and Lids',
       'prek', 'montessori', 'practical_life', 'courseware',
       '精细动作：基础动作', 'published', t.id, '{"category": "精细动作：基础动作", "categoryEn": "精细动作：基础动作 Fine Motor Skills", "itemType": "lesson", "itemIndex": 3, "title": "开关", "titleEn": "Containers and Lids", "slide": 19, "age": "3", "aim": "发展幼儿专注力，协调性，独立性，有序性", "aimEn": "Control & coordination of movement, concentration, independence, sense of order", "language": "拧，拧紧了", "languageEn": "Screw, screwed it tight"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'practical_life'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '精细动作：基础动作'
      AND r.title = '开关'
      AND r.description::json->>'itemIndex' = '3'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '倒干物', 'Dry Pouring',
       'prek', 'montessori', 'practical_life', 'courseware',
       '精细动作：基础动作', 'published', t.id, '{"category": "精细动作：基础动作", "categoryEn": "精细动作：基础动作 Fine Motor Skills", "itemType": "lesson", "itemIndex": 4, "title": "倒干物", "titleEn": "Dry Pouring", "slide": 21, "age": "3", "aim": "发展幼儿专注力，协调性，独立性，有序性", "aimEn": "Control & coordination of movement, concentration, independence, sense of order", "language": "倒,空,满", "languageEn": "Pour, empty, filled"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'practical_life'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '精细动作：基础动作'
      AND r.title = '倒干物'
      AND r.description::json->>'itemIndex' = '4'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '使用海绵', 'Using a Sponge',
       'prek', 'montessori', 'practical_life', 'courseware',
       '精细动作：基础动作', 'published', t.id, '{"category": "精细动作：基础动作", "categoryEn": "精细动作：基础动作 Fine Motor Skills", "itemType": "lesson", "itemIndex": 5, "title": "使用海绵", "titleEn": "Using a Sponge", "slide": 23, "age": "3", "aim": "发展幼儿专注力，协调性，独立性，有序性", "aimEn": "Control & coordination of movement, concentration, independence, sense of order", "language": "海绵、吸水", "languageEn": "Sponge,absorb"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'practical_life'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '精细动作：基础动作'
      AND r.title = '使用海绵'
      AND r.description::json->>'itemIndex' = '5'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '倒液体', 'Liquid Pouring',
       'prek', 'montessori', 'practical_life', 'courseware',
       '精细动作：基础动作', 'published', t.id, '{"category": "精细动作：基础动作", "categoryEn": "精细动作：基础动作 Fine Motor Skills", "itemType": "lesson", "itemIndex": 6, "title": "倒液体", "titleEn": "Liquid Pouring", "slide": 25, "age": "3", "aim": "发展幼儿专注力，协调性，独立性，有序性", "aimEn": "Control & coordination of movement, concentration, independence, sense of order", "language": "倒，空，满", "languageEn": "Pour, empty, filled"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'practical_life'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '精细动作：基础动作'
      AND r.title = '倒液体'
      AND r.description::json->>'itemIndex' = '6'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '舀干物', 'Dry Spooning',
       'prek', 'montessori', 'practical_life', 'courseware',
       '精细动作：基础动作', 'published', t.id, '{"category": "精细动作：基础动作", "categoryEn": "精细动作：基础动作 Fine Motor Skills", "itemType": "lesson", "itemIndex": 7, "title": "舀干物", "titleEn": "Dry Spooning", "slide": 27, "age": "3", "aim": "发展幼儿专注力，协调性，独立性，有序性", "aimEn": "Control & coordination of movement, concentration, independence, sense of order", "language": "舀，空，满", "languageEn": "Scoop,empty,filled"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'practical_life'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '精细动作：基础动作'
      AND r.title = '舀干物'
      AND r.description::json->>'itemIndex' = '7'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '使用夹子', 'Tong Transfer',
       'prek', 'montessori', 'practical_life', 'courseware',
       '精细动作：基础动作', 'published', t.id, '{"category": "精细动作：基础动作", "categoryEn": "精细动作：基础动作 Fine Motor Skills", "itemType": "lesson", "itemIndex": 8, "title": "使用夹子", "titleEn": "Tong Transfer", "slide": 29, "age": "3", "aim": "发展幼儿专注力，协调性，独立性，有序性", "aimEn": "Control & coordination of movement, concentration, independence, sense of order", "language": "夹子，夹起来", "languageEn": "Clip, clip up"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'practical_life'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '精细动作：基础动作'
      AND r.title = '使用夹子'
      AND r.description::json->>'itemIndex' = '8'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '使用衣夹', 'Clothespins',
       'prek', 'montessori', 'practical_life', 'courseware',
       '精细动作：基础动作', 'published', t.id, '{"category": "精细动作：基础动作", "categoryEn": "精细动作：基础动作 Fine Motor Skills", "itemType": "lesson", "itemIndex": 9, "title": "使用衣夹", "titleEn": "Clothespins", "slide": 31, "age": "3", "aim": "发展幼儿专注力，协调性，独立性，有序性", "aimEn": "Control & coordination of movement, concentration, independence, sense of order", "language": "衣夹、三指捏、打开、夹住", "languageEn": "Clothes pegs, tripod pinch, open, clip"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'practical_life'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '精细动作：基础动作'
      AND r.title = '使用衣夹'
      AND r.description::json->>'itemIndex' = '9'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '捞', 'Sifting',
       'prek', 'montessori', 'practical_life', 'courseware',
       '精细动作：基础动作', 'published', t.id, '{"category": "精细动作：基础动作", "categoryEn": "精细动作：基础动作 Fine Motor Skills", "itemType": "lesson", "itemIndex": 10, "title": "捞", "titleEn": "Sifting", "slide": 33, "age": "3", "aim": "发展幼儿专注力，协调性，独立性，有序性", "aimEn": "Control & coordination of movement, concentration, independence, sense of order", "language": "捞筛、捞起来", "languageEn": "Sieve, scoop up"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'practical_life'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '精细动作：基础动作'
      AND r.title = '捞'
      AND r.description::json->>'itemIndex' = '10'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '滴管', 'Using a Baster',
       'prek', 'montessori', 'practical_life', 'courseware',
       '精细动作：基础动作', 'published', t.id, '{"category": "精细动作：基础动作", "categoryEn": "精细动作：基础动作 Fine Motor Skills", "itemType": "lesson", "itemIndex": 11, "title": "滴管", "titleEn": "Using a Baster", "slide": 35, "age": "3", "aim": "发展幼儿专注力，协调性，独立性，有序性", "aimEn": "Control & coordination of movement, concentration, independence, sense of order", "language": "滴管、海绵、捏、吸上来、挤出来", "languageEn": "Dropper, sponge, pinch, suck up, squeeze out"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'practical_life'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '精细动作：基础动作'
      AND r.title = '滴管'
      AND r.description::json->>'itemIndex' = '11'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '拧螺丝', 'Nuts and Bolts',
       'prek', 'montessori', 'practical_life', 'courseware',
       '精细动作：基础动作', 'published', t.id, '{"category": "精细动作：基础动作", "categoryEn": "精细动作：基础动作 Fine Motor Skills", "itemType": "lesson", "itemIndex": 12, "title": "拧螺丝", "titleEn": "Nuts and Bolts", "slide": 37, "age": "3-4岁", "aim": "学会将螺丝与螺母通过旋转动作拧合与分离", "aimEn": "Learn to assemble and separate screws and nuts by rotating", "language": "螺丝，螺母，拧紧，拧松，旋转", "languageEn": "Screw, Nut, Tighten, Loosen, Turn"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'practical_life'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '精细动作：基础动作'
      AND r.title = '拧螺丝'
      AND r.description::json->>'itemIndex' = '12'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '使用螺丝刀', 'Using a Screwdriver',
       'prek', 'montessori', 'practical_life', 'courseware',
       '精细动作：基础动作', 'published', t.id, '{"category": "精细动作：基础动作", "categoryEn": "精细动作：基础动作 Fine Motor Skills", "itemType": "lesson", "itemIndex": 13, "title": "使用螺丝刀", "titleEn": "Using a Screwdriver", "slide": 39, "age": "3-4", "aim": "学习正确使用简单工具（螺丝刀）。", "aimEn": "ion (in/out) Key Language: Screwdriver, screw, screw in, screw out, turn Age: 3-4 Goals: Direct-Learn to use a simple tool (screwdriver) correctly", "language": "螺丝刀，螺丝，拧进去，拧出来，旋转", "languageEn": "Screwdriver, screw, screw in, screw out, turn"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'practical_life'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '精细动作：基础动作'
      AND r.title = '使用螺丝刀'
      AND r.description::json->>'itemIndex' = '13'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '开锁', 'Locks and Keys',
       'prek', 'montessori', 'practical_life', 'courseware',
       '精细动作：基础动作', 'published', t.id, '{"category": "精细动作：基础动作", "categoryEn": "精细动作：基础动作 Fine Motor Skills", "itemType": "lesson", "itemIndex": 14, "title": "开锁", "titleEn": "Locks and Keys", "slide": 41, "age": "3-4岁", "aim": "学习“开锁”这一重要的生活技能", "aimEn": "Learn the practical life skill of unlocking", "language": "锁，钥匙，打开，锁上，插入，转动", "languageEn": "Lock, key, open, lock, insert, turn"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'practical_life'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '精细动作：基础动作'
      AND r.title = '开锁'
      AND r.description::json->>'itemIndex' = '14'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '搅拌', 'Whisking',
       'prek', 'montessori', 'practical_life', 'courseware',
       '精细动作：基础动作', 'published', t.id, '{"category": "精细动作：基础动作", "categoryEn": "精细动作：基础动作 Fine Motor Skills", "itemType": "lesson", "itemIndex": 15, "title": "搅拌", "titleEn": "Whisking", "slide": 43, "age": "3-5", "aim": "练习手腕旋转的协调动作", "aimEn": "Practice coordinated wrist rotation", "language": "泡泡、旋转、泡沫", "languageEn": "Bubbles, whisk, foam"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'practical_life'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '精细动作：基础动作'
      AND r.title = '搅拌'
      AND r.description::json->>'itemIndex' = '15'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '叠', 'Folding',
       'prek', 'montessori', 'practical_life', 'courseware',
       '精细动作：基础动作', 'published', t.id, '{"category": "精细动作：基础动作", "categoryEn": "精细动作：基础动作 Fine Motor Skills", "itemType": "lesson", "itemIndex": 16, "title": "叠", "titleEn": "Folding", "slide": 45, "age": "2.5-4岁", "aim": "按标记线将布对折整齐", "aimEn": "Fold cloth neatly along guide lines", "language": "叠、对齐、边、线", "languageEn": "Fold, align, edge, line"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'practical_life'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '精细动作：基础动作'
      AND r.title = '叠'
      AND r.description::json->>'itemIndex' = '16'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '剪毛线', 'Cutting Yarn',
       'prek', 'montessori', 'practical_life', 'courseware',
       '精细动作：基础动作', 'published', t.id, '{"category": "精细动作：基础动作", "categoryEn": "精细动作：基础动作 Fine Motor Skills", "itemType": "lesson", "itemIndex": 17, "title": "剪毛线", "titleEn": "Cutting Yarn", "slide": 47, "age": "3-4岁", "aim": "学会使用剪刀将毛线剪成小段", "aimEn": "Learn to cut yarn into small pieces using scissors", "language": "剪、开、合、毛线", "languageEn": "Cut, open, close, yarn"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'practical_life'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '精细动作：基础动作'
      AND r.title = '剪毛线'
      AND r.description::json->>'itemIndex' = '17'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '打结', 'Tying Knots',
       'prek', 'montessori', 'practical_life', 'courseware',
       '精细动作：基础动作', 'published', t.id, '{"category": "精细动作：基础动作", "categoryEn": "精细动作：基础动作 Fine Motor Skills", "itemType": "lesson", "itemIndex": 18, "title": "打结", "titleEn": "Tying Knots", "slide": 49, "age": "4-5岁", "aim": "学会打一个单结", "aimEn": "Learn to tie a simple knot", "language": "交叉、穿、拉紧、结", "languageEn": "Cross, thread, tighten, knot"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'practical_life'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '精细动作：基础动作'
      AND r.title = '打结'
      AND r.description::json->>'itemIndex' = '18'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '穿珠子', 'Bead Stringing',
       'prek', 'montessori', 'practical_life', 'courseware',
       '精细动作：基础动作', 'published', t.id, '{"category": "精细动作：基础动作", "categoryEn": "精细动作：基础动作 Fine Motor Skills", "itemType": "lesson", "itemIndex": 19, "title": "穿珠子", "titleEn": "Bead Stringing", "slide": 51, "age": "3-4岁", "aim": "将珠子依次穿到线上，并学会剪断绳子", "aimEn": "String beads in sequence and learn to cut the string", "language": "穿、珠子、线、剪", "languageEn": "Thread, bead, string, cut"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'practical_life'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '精细动作：基础动作'
      AND r.title = '穿珠子'
      AND r.description::json->>'itemIndex' = '19'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '穿卡片', 'Lacing Cards',
       'prek', 'montessori', 'practical_life', 'courseware',
       '精细动作：基础动作', 'published', t.id, '{"category": "精细动作：基础动作", "categoryEn": "精细动作：基础动作 Fine Motor Skills", "itemType": "lesson", "itemIndex": 20, "title": "穿卡片", "titleEn": "Lacing Cards", "slide": 53, "age": "3-4岁", "aim": "按卡片上孔洞的顺序正确穿线", "aimEn": "Lace string through holes in correct order", "language": "穿、卡片、孔、顺序", "languageEn": "Lace, card, hole, sequence"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'practical_life'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '精细动作：基础动作'
      AND r.title = '穿卡片'
      AND r.description::json->>'itemIndex' = '20'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '穿针引线', 'Threading a Needle',
       'prek', 'montessori', 'practical_life', 'courseware',
       '精细动作：基础动作', 'published', t.id, '{"category": "精细动作：基础动作", "categoryEn": "精细动作：基础动作 Fine Motor Skills", "itemType": "lesson", "itemIndex": 21, "title": "穿针引线", "titleEn": "Threading a Needle", "slide": 55, "age": "4.5-6岁", "aim": "使用穿线器（或徒手）将线穿过针眼", "aimEn": "Thread a needle using a threader (or by hand)", "language": "穿、针眼、线头、拉紧", "languageEn": "Thread, needle eye, thread end, pull tight"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'practical_life'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '精细动作：基础动作'
      AND r.title = '穿针引线'
      AND r.description::json->>'itemIndex' = '21'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '缝扣子', 'Button Sewing',
       'prek', 'montessori', 'practical_life', 'courseware',
       '精细动作：基础动作', 'published', t.id, '{"category": "精细动作：基础动作", "categoryEn": "精细动作：基础动作 Fine Motor Skills", "itemType": "lesson", "itemIndex": 22, "title": "缝扣子", "titleEn": "Button Sewing", "slide": 57, "age": "4.5-6岁", "aim": "学会将扣子缝在布上", "aimEn": "Learn to sew a button onto fabric", "language": "缝、扣子、扣眼、穿过、打结", "languageEn": "Sew, button, buttonhole, through, knot"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'practical_life'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '精细动作：基础动作'
      AND r.title = '缝扣子'
      AND r.description::json->>'itemIndex' = '22'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '橡皮泥', 'Using Playdough',
       'prek', 'montessori', 'practical_life', 'courseware',
       '艺术', 'published', t.id, '{"category": "艺术", "categoryEn": "Art", "itemType": "lesson", "itemIndex": 1, "title": "橡皮泥", "titleEn": "Using Playdough", "slide": 61, "age": "2.5", "aim": "发展幼儿专注力，协调性，独立性，有序性", "aimEn": "Control & coordination of movement, concentration, independence, sense of order", "language": "捏、揉、压、搓、切、橡皮泥、形状、柔软、有弹性", "languageEn": "Pinch, knead, press, roll, cut, playdough, shape, soft, elastic"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'practical_life'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '艺术'
      AND r.title = '橡皮泥'
      AND r.description::json->>'itemIndex' = '1'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '蜡笔的使用（马克笔，铅笔）', 'Use of Crayons (Markers, Pencils)',
       'prek', 'montessori', 'practical_life', 'courseware',
       '艺术', 'published', t.id, '{"category": "艺术", "categoryEn": "Art", "itemType": "lesson", "itemIndex": 2, "title": "蜡笔的使用（马克笔，铅笔）", "titleEn": "Use of Crayons (Markers, Pencils)", "slide": 63, "age": "2.5", "aim": "发展幼儿专注力，协调性，独立性，有序性", "aimEn": "Control & coordination of movement, concentration, independence, sense of order", "language": "画、涂、蜡笔、颜色、痕迹、轻轻地、握住", "languageEn": "Draw, color, crayon, color, mark, gently, hold"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'practical_life'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '艺术'
      AND r.title = '蜡笔的使用（马克笔，铅笔）'
      AND r.description::json->>'itemIndex' = '2'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '压花', 'Punching',
       'prek', 'montessori', 'practical_life', 'courseware',
       '艺术', 'published', t.id, '{"category": "艺术", "categoryEn": "Art", "itemType": "lesson", "itemIndex": 3, "title": "压花", "titleEn": "Punching", "slide": 65, "age": "3", "aim": "发展幼儿专注力，协调性，独立性，有序性", "aimEn": "Control & coordination of movement, concentration, independence, sense of order", "language": "压花、纹理、按压、对齐、图案、凸起、轻轻地", "languageEn": "Embossing, texture, press, align, pattern, raised, gently"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'practical_life'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '艺术'
      AND r.title = '压花'
      AND r.description::json->>'itemIndex' = '3'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '剪纸', 'Cutting Paper',
       'prek', 'montessori', 'practical_life', 'courseware',
       '艺术', 'published', t.id, '{"category": "艺术", "categoryEn": "Art", "itemType": "lesson", "itemIndex": 4, "title": "剪纸", "titleEn": "Cutting Paper", "slide": 67, "age": "2.5", "aim": "发展幼儿专注力，协调性，独立性，有序性", "aimEn": "Control & coordination of movement, concentration, independence, sense of order", "language": "剪、剪刀、纸条、碎片、打开、合上、小心", "languageEn": "Cut, scissors, paper strips, pieces, open, close, careful"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'practical_life'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '艺术'
      AND r.title = '剪纸'
      AND r.description::json->>'itemIndex' = '4'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '订书机', 'Stapling',
       'prek', 'montessori', 'practical_life', 'courseware',
       '艺术', 'published', t.id, '{"category": "艺术", "categoryEn": "Art", "itemType": "lesson", "itemIndex": 5, "title": "订书机", "titleEn": "Stapling", "slide": 69, "age": "2.5", "aim": "发展幼儿专注力，协调性，独立性，有序性", "aimEn": "Control & coordination of movement, concentration, independence, sense of order", "language": "订书机、装订、对齐、按压、书钉、小心、取出", "languageEn": "Stapler, staple, align, press, fasten, careful, remove"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'practical_life'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '艺术'
      AND r.title = '订书机'
      AND r.description::json->>'itemIndex' = '5'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '粘贴', 'Glue and Paste',
       'prek', 'montessori', 'practical_life', 'courseware',
       '艺术', 'published', t.id, '{"category": "艺术", "categoryEn": "Art", "itemType": "lesson", "itemIndex": 6, "title": "粘贴", "titleEn": "Glue and Paste", "slide": 71, "age": "3", "aim": "发展幼儿专注力，协调性，独立性，有序性", "aimEn": "Control & coordination of movement, concentration, independence, sense of order", "language": "粘贴、胶水、涂抹、对齐、压平、附着、清洁", "languageEn": "Paste, glue, apply, align, press flat, adhere, clean"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'practical_life'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '艺术'
      AND r.title = '粘贴'
      AND r.description::json->>'itemIndex' = '6'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '折纸', 'Origami',
       'prek', 'montessori', 'practical_life', 'courseware',
       '艺术', 'published', t.id, '{"category": "艺术", "categoryEn": "Art", "itemType": "lesson", "itemIndex": 7, "title": "折纸", "titleEn": "Origami", "slide": 73, "age": "3", "aim": "发展幼儿专注力，协调性，独立性，有序性", "aimEn": "Control & coordination of movement, concentration, independence, sense of order", "language": "折纸、对折、边角、对齐、压平、折痕、展开", "languageEn": "Origami, fold, corner, edge, align, flatten, crease, unfold"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'practical_life'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '艺术'
      AND r.title = '折纸'
      AND r.description::json->>'itemIndex' = '7'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '刺工', 'Stabbing',
       'prek', 'montessori', 'practical_life', 'courseware',
       '艺术', 'published', t.id, '{"category": "艺术", "categoryEn": "Art", "itemType": "lesson", "itemIndex": 8, "title": "刺工", "titleEn": "Stabbing", "slide": 75, "age": "3", "aim": "发展幼儿专注力，协调性，独立性，有序性", "aimEn": "Control & coordination of movement, concentration, independence, sense of order", "language": "刺工、针、穿刺、孔洞、轮廓、连续、小心", "languageEn": "Pricking, needle, pierce, holes, outline, continuous, careful"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'practical_life'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '艺术'
      AND r.title = '刺工'
      AND r.description::json->>'itemIndex' = '8'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '编织', 'Plaiting',
       'prek', 'montessori', 'practical_life', 'courseware',
       '艺术', 'published', t.id, '{"category": "艺术", "categoryEn": "Art", "itemType": "lesson", "itemIndex": 9, "title": "编织", "titleEn": "Plaiting", "slide": 77, "age": "4", "aim": "发展幼儿专注力，协调性，独立性，有序性", "aimEn": "Control & coordination of movement, concentration, independence, sense of order", "language": "编织、穿插、上下交替、拉紧、纹理、规律", "languageEn": "Weave, interlacing, over-under, tighten, texture, pattern"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'practical_life'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '艺术'
      AND r.title = '编织'
      AND r.description::json->>'itemIndex' = '9'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '除尘', 'Dusting',
       'prek', 'montessori', 'practical_life', 'courseware',
       '照顾环境', 'published', t.id, '{"category": "照顾环境", "categoryEn": "Care of the Environment", "itemType": "lesson", "itemIndex": 1, "title": "除尘", "titleEn": "Dusting", "slide": 80, "age": "2.5-3", "aim": "发展幼儿动作协调性，生活独立性，培养照顾环境的意识", "aimEn": "Control & coordination of movement, independence, sense of caring the environment", "language": "除尘", "languageEn": "Dusting the shelf"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'practical_life'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '照顾环境'
      AND r.title = '除尘'
      AND r.description::json->>'itemIndex' = '1'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '扫', 'Sweeping',
       'prek', 'montessori', 'practical_life', 'courseware',
       '照顾环境', 'published', t.id, '{"category": "照顾环境", "categoryEn": "Care of the Environment", "itemType": "lesson", "itemIndex": 2, "title": "扫", "titleEn": "Sweeping", "slide": 82, "age": "2.5-3", "aim": "发展幼儿动作协调性，生活独立性，培养照顾环境的意识", "aimEn": "Control & coordination of movement, independence, sense of caring the environment", "language": "清扫地面与桌面，扫把，簸箕", "languageEn": "Sweep the floor/table, broom, dustpan"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'practical_life'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '照顾环境'
      AND r.title = '扫'
      AND r.description::json->>'itemIndex' = '2'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '拖地', 'Mopping',
       'prek', 'montessori', 'practical_life', 'courseware',
       '照顾环境', 'published', t.id, '{"category": "照顾环境", "categoryEn": "Care of the Environment", "itemType": "lesson", "itemIndex": 3, "title": "拖地", "titleEn": "Mopping", "slide": 84, "age": "2.5-3", "aim": "发展幼儿动作协调性，生活独立性，培养照顾环境的意识", "aimEn": "Control & coordination of movement, independence, sense of caring the environment", "language": "拖地，水桶，清洁", "languageEn": "Mop the floor, bucket, clean"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'practical_life'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '照顾环境'
      AND r.title = '拖地'
      AND r.description::json->>'itemIndex' = '3'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '擦桌子', 'Wiping a Table',
       'prek', 'montessori', 'practical_life', 'courseware',
       '照顾环境', 'published', t.id, '{"category": "照顾环境", "categoryEn": "Care of the Environment", "itemType": "lesson", "itemIndex": 4, "title": "擦桌子", "titleEn": "Wiping a Table", "slide": 86, "age": "2.5-3", "aim": "发展幼儿动作协调性，生活独立性，培养照顾环境的意识", "aimEn": "Control & coordination of movement, independence, sense of caring the environment", "language": "擦桌子，脏，清洁", "languageEn": "Wipe the table, diety, clean"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'practical_life'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '照顾环境'
      AND r.title = '擦桌子'
      AND r.description::json->>'itemIndex' = '4'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '刷工作毯', 'Brushing Work Mats',
       'prek', 'montessori', 'practical_life', 'courseware',
       '照顾环境', 'published', t.id, '{"category": "照顾环境", "categoryEn": "Care of the Environment", "itemType": "lesson", "itemIndex": 5, "title": "刷工作毯", "titleEn": "Brushing Work Mats", "slide": 88, "age": "2.5-3", "aim": "发展幼儿动作协调性，生活独立性，培养照顾环境的意识", "aimEn": "Control & coordination of movement, independence, sense of caring the environment", "language": "扫，刷，工作毯", "languageEn": "Dust, brush, work mat"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'practical_life'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '照顾环境'
      AND r.title = '刷工作毯'
      AND r.description::json->>'itemIndex' = '5'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '刮玻璃', 'Wiping the Glass',
       'prek', 'montessori', 'practical_life', 'courseware',
       '照顾环境', 'published', t.id, '{"category": "照顾环境", "categoryEn": "Care of the Environment", "itemType": "lesson", "itemIndex": 6, "title": "刮玻璃", "titleEn": "Wiping the Glass", "slide": 90, "age": "2.5-3", "aim": "发展幼儿动作协调性，生活独立性，培养照顾环境的意识", "aimEn": "Control & coordination of movement, independence, sense of caring the environment", "language": "窗户，镜子，喷，刮，擦", "languageEn": "Window, mirror, spray, wipe"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'practical_life'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '照顾环境'
      AND r.title = '刮玻璃'
      AND r.description::json->>'itemIndex' = '6'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '抛光', 'Polishing',
       'prek', 'montessori', 'practical_life', 'courseware',
       '照顾环境', 'published', t.id, '{"category": "照顾环境", "categoryEn": "Care of the Environment", "itemType": "lesson", "itemIndex": 7, "title": "抛光", "titleEn": "Polishing", "slide": 92, "age": "3+", "aim": "发展幼儿动作协调性、工作步骤的逻辑性，培养照顾环境的意识", "aimEn": "Control & coordination of movement, following a logical sequence of action, sense of caring the environment", "language": "抛光", "languageEn": "Dusting the shelf"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'practical_life'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '照顾环境'
      AND r.title = '抛光'
      AND r.description::json->>'itemIndex' = '7'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '清洁植物', 'Cleaning a Plant',
       'prek', 'montessori', 'practical_life', 'courseware',
       '照顾环境', 'published', t.id, '{"category": "照顾环境", "categoryEn": "Care of the Environment", "itemType": "lesson", "itemIndex": 8, "title": "清洁植物", "titleEn": "Cleaning a Plant", "slide": 94, "age": "3+", "aim": "发展幼儿动作协调性，培养照顾环境的意识", "aimEn": "Control & coordination of movement, sense of caring the environment", "language": "植物，叶子，剪下，刷，擦", "languageEn": "Plant, leaf, cut down, brush, wipe"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'practical_life'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '照顾环境'
      AND r.title = '清洁植物'
      AND r.description::json->>'itemIndex' = '8'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '给植物浇水', 'Watering Plants',
       'prek', 'montessori', 'practical_life', 'courseware',
       '照顾环境', 'published', t.id, '{"category": "照顾环境", "categoryEn": "Care of the Environment", "itemType": "lesson", "itemIndex": 9, "title": "给植物浇水", "titleEn": "Watering Plants", "slide": 96, "age": "2.5-3", "aim": "发展幼儿动作协调性，培养照顾环境的意识", "aimEn": "Control & coordination of movement, sense of caring the environment", "language": "浇水壶", "languageEn": "Watering can"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'practical_life'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '照顾环境'
      AND r.title = '给植物浇水'
      AND r.description::json->>'itemIndex' = '9'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '插花', 'Flower Arranging',
       'prek', 'montessori', 'practical_life', 'courseware',
       '照顾环境', 'published', t.id, '{"category": "照顾环境", "categoryEn": "Care of the Environment", "itemType": "lesson", "itemIndex": 10, "title": "插花", "titleEn": "Flower Arranging", "slide": 98, "age": "3+", "aim": "发展幼儿动作协调性，培养照顾环境、美化环境的意识，美学教育", "aimEn": "Control & coordination of movement, sense of caring the environment, development of aesthetic sense", "language": "闻花，剪花茎，插花，高一点、矮一点，放进花瓶", "languageEn": "Smell the flower, cut the syem, arrange flowers, taller/shorter, put in the vase"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'practical_life'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '照顾环境'
      AND r.title = '插花'
      AND r.description::json->>'itemIndex' = '10'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '削铅笔', 'Pencil Sharpening',
       'prek', 'montessori', 'practical_life', 'courseware',
       '照顾环境', 'published', t.id, '{"category": "照顾环境", "categoryEn": "Care of the Environment", "itemType": "lesson", "itemIndex": 11, "title": "削铅笔", "titleEn": "Pencil Sharpening", "slide": 100, "age": "3+", "aim": "发展幼儿动作协调性，独立性，培养照顾环境的意识", "aimEn": "Control & coordination of movement, independence, sense of caring the environment", "language": "铅笔刀，扭", "languageEn": "Pencil sharpener, twist"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'practical_life'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '照顾环境'
      AND r.title = '削铅笔'
      AND r.description::json->>'itemIndex' = '11'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '布置桌子', 'Setting a Table',
       'prek', 'montessori', 'practical_life', 'courseware',
       '照顾环境', 'published', t.id, '{"category": "照顾环境", "categoryEn": "Care of the Environment", "itemType": "lesson", "itemIndex": 12, "title": "布置桌子", "titleEn": "Setting a Table", "slide": 102, "age": "3+", "aim": "发展幼儿动作协调性，独立性，培养照顾自己的意识", "aimEn": "Control & coordination of movement, independence, sense of self-care", "language": "布置桌子，餐具名称", "languageEn": "Set up the table, names of the tableware"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'practical_life'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '照顾环境'
      AND r.title = '布置桌子'
      AND r.description::json->>'itemIndex' = '12'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '照顾动物', 'Care of Classroom Animals',
       'prek', 'montessori', 'practical_life', 'courseware',
       '照顾环境', 'published', t.id, '{"category": "照顾环境", "categoryEn": "Care of the Environment", "itemType": "lesson", "itemIndex": 13, "title": "照顾动物", "titleEn": "Care of Classroom Animals", "slide": 104, "age": "3+", "aim": "发展幼儿动作协调性，培养照顾环境与环境中的动物的意识", "aimEn": "Control & coordination of movement, sense of caring the environment and the animals", "language": "动物名称", "languageEn": "Animal name"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'practical_life'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '照顾环境'
      AND r.title = '照顾动物'
      AND r.description::json->>'itemIndex' = '13'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '咳嗽', 'Coughing',
       'prek', 'montessori', 'practical_life', 'courseware',
       '照顾自己', 'published', t.id, '{"category": "照顾自己", "categoryEn": "Care of Oneself", "itemType": "lesson", "itemIndex": 1, "title": "咳嗽", "titleEn": "Coughing", "slide": 107, "age": "3+", "aim": "掌握咳嗽时用纸巾或手肘遮挡口鼻、转头侧身的正确方法", "aimEn": "Master the correct way to cover mouth and nose with tissue or elbow, turn head and body sideways when coughing", "language": "“咳嗽时要捂住口鼻“", "languageEn": "Cover your mouth and nose when coughing"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'practical_life'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '照顾自己'
      AND r.title = '咳嗽'
      AND r.description::json->>'itemIndex' = '1'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '擤鼻涕', 'Blowing One''s Nose',
       'prek', 'montessori', 'practical_life', 'courseware',
       '照顾自己', 'published', t.id, '{"category": "照顾自己", "categoryEn": "Care of Oneself", "itemType": "lesson", "itemIndex": 2, "title": "擤鼻涕", "titleEn": "Blowing One''s Nose", "slide": 109, "age": "3+", "aim": "待补充", "aimEn": "Master the correct steps: \"Take a tissue → Press one nostril and wipe gently →Switch to the other nostril → Discard the tissue → Wash hands\"", "language": "“纸巾轻轻捂，按住一边擤，用完扔桶里，小手洗干净”", "languageEn": "—"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'practical_life'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '照顾自己'
      AND r.title = '擤鼻涕'
      AND r.description::json->>'itemIndex' = '2'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '换鞋', 'Changing Shoes',
       'prek', 'montessori', 'practical_life', 'courseware',
       '照顾自己', 'published', t.id, '{"category": "照顾自己", "categoryEn": "Care of Oneself", "itemType": "lesson", "itemIndex": 3, "title": "换鞋", "titleEn": "Changing Shoes", "slide": 111, "age": "2.5-4岁", "aim": "待补充", "aimEn": "Master change process: Take off→Arrange→Put on→Put back; tell left/right shoes", "language": "轻轻脱鞋，摆放整齐，慢慢穿鞋", "languageEn": "—"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'practical_life'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '照顾自己'
      AND r.title = '换鞋'
      AND r.description::json->>'itemIndex' = '3'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '使用卫生间', 'Using the Bathroom',
       'prek', 'montessori', 'practical_life', 'courseware',
       '照顾自己', 'published', t.id, '{"category": "照顾自己", "categoryEn": "Care of Oneself", "itemType": "lesson", "itemIndex": 4, "title": "使用卫生间", "titleEn": "Using the Bathroom", "slide": 113, "age": "待标注", "aim": "待补充", "aimEn": "Independent bathroom routine; correct handwashing", "language": "", "languageEn": "Toilet, flush"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'practical_life'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '照顾自己'
      AND r.title = '使用卫生间'
      AND r.description::json->>'itemIndex' = '4'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '洗手', 'Hand Washing',
       'prek', 'montessori', 'practical_life', 'courseware',
       '照顾自己', 'published', t.id, '{"category": "照顾自己", "categoryEn": "Care of Oneself", "itemType": "lesson", "itemIndex": 5, "title": "洗手", "titleEn": "Hand Washing", "slide": 115, "age": "2-4岁", "aim": "独立完成洗手流程", "aimEn": "Finish handwashing independently", "language": "搓手心/手背/指缝、冲干净、放回原位", "languageEn": "Rub palms/backs/fingertips, rinse well, put back"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'practical_life'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '照顾自己'
      AND r.title = '洗手'
      AND r.description::json->>'itemIndex' = '5'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '叠外套', 'Jacket Flip',
       'prek', 'montessori', 'practical_life', 'courseware',
       '照顾自己', 'published', t.id, '{"category": "照顾自己", "categoryEn": "Care of Oneself", "itemType": "lesson", "itemIndex": 6, "title": "叠外套", "titleEn": "Jacket Flip", "slide": 117, "age": "3+", "aim": "独立掌握叠外套基本流程", "aimEn": "Master basic jacket-folding independently", "language": "铺平、对齐边角、折叠中线、放整齐", "languageEn": "Flatten, align edges, fold along the middle, put neatly"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'practical_life'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '照顾自己'
      AND r.title = '叠外套'
      AND r.description::json->>'itemIndex' = '6'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '拉链衣饰框', 'Zipper Frame',
       'prek', 'montessori', 'practical_life', 'courseware',
       '照顾自己', 'published', t.id, '{"category": "照顾自己", "categoryEn": "Care of Oneself", "itemType": "lesson", "itemIndex": 7, "title": "拉链衣饰框", "titleEn": "Zipper Frame", "slide": 119, "age": "3+", "aim": "发展专注力、协调性、独立性和秩序感", "aimEn": "Develop concentration, coordination, independence and a sense of order", "language": "拉链打开了，衣饰框也打开了；拉链拉好了，衣饰框闭合了", "languageEn": "The zipper is open, and the dressing frame is open; The zipper is closed, and the dressing frame is closed"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'practical_life'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '照顾自己'
      AND r.title = '拉链衣饰框'
      AND r.description::json->>'itemIndex' = '7'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '纽扣衣饰框', 'Button Frame',
       'prek', 'montessori', 'practical_life', 'courseware',
       '照顾自己', 'published', t.id, '{"category": "照顾自己", "categoryEn": "Care of Oneself", "itemType": "lesson", "itemIndex": 8, "title": "纽扣衣饰框", "titleEn": "Button Frame", "slide": 121, "age": "3+", "aim": "发展专注力、协调性、独立性和秩序感", "aimEn": "Develop concentration, coordination, independence and a sense of order", "language": "纽扣解开了；系好了", "languageEn": "The button is unfastened; The button is fastened"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'practical_life'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '照顾自己'
      AND r.title = '纽扣衣饰框'
      AND r.description::json->>'itemIndex' = '8'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '按扣衣饰框', 'Snap Frame',
       'prek', 'montessori', 'practical_life', 'courseware',
       '照顾自己', 'published', t.id, '{"category": "照顾自己", "categoryEn": "Care of Oneself", "itemType": "lesson", "itemIndex": 9, "title": "按扣衣饰框", "titleEn": "Snap Frame", "slide": 123, "age": "3+", "aim": "发展专注力、协调性、独立性和秩序感", "aimEn": "Develop concentration, coordination, independence and a sense of order.", "language": "拉开；按住；扣上", "languageEn": "Pull open; Press; Snap shut"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'practical_life'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '照顾自己'
      AND r.title = '按扣衣饰框'
      AND r.description::json->>'itemIndex' = '9'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '挂扣衣饰框', 'Hook and Eye Frame',
       'prek', 'montessori', 'practical_life', 'courseware',
       '照顾自己', 'published', t.id, '{"category": "照顾自己", "categoryEn": "Care of Oneself", "itemType": "lesson", "itemIndex": 10, "title": "挂扣衣饰框", "titleEn": "Hook and Eye Frame", "slide": 125, "age": "3+", "aim": "发展专注力、协调性、独立性和秩序感", "aimEn": "Develop concentration, coordination, independence and a sense of order", "language": "解开；扣住", "languageEn": "Undo; Fasten"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'practical_life'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '照顾自己'
      AND r.title = '挂扣衣饰框'
      AND r.description::json->>'itemIndex' = '10'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '皮带扣衣饰框', 'Buckle Frame',
       'prek', 'montessori', 'practical_life', 'courseware',
       '照顾自己', 'published', t.id, '{"category": "照顾自己", "categoryEn": "Care of Oneself", "itemType": "lesson", "itemIndex": 11, "title": "皮带扣衣饰框", "titleEn": "Buckle Frame", "slide": 127, "age": "3+", "aim": "发展专注力、协调性、独立性和秩序感", "aimEn": "Develop concentration, coordination, independence and a sense of order", "language": "皮带扣解开了，衣饰框打开了", "languageEn": "The belt buckle is unfastened; The dressing frame is open"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'practical_life'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '照顾自己'
      AND r.title = '皮带扣衣饰框'
      AND r.description::json->>'itemIndex' = '11'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '蝴蝶结衣饰框', 'Bow Frame',
       'prek', 'montessori', 'practical_life', 'courseware',
       '照顾自己', 'published', t.id, '{"category": "照顾自己", "categoryEn": "Care of Oneself", "itemType": "lesson", "itemIndex": 12, "title": "蝴蝶结衣饰框", "titleEn": "Bow Frame", "slide": 129, "age": "3+", "aim": "发展专注力、协调性、独立性和秩序感", "aimEn": "Develop concentration, coordination, independence and a sense of order", "language": "蝴蝶结全部解开了；我系好了蝴蝶结", "languageEn": "All bows are untied; I have tied the bow"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'practical_life'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '照顾自己'
      AND r.title = '蝴蝶结衣饰框'
      AND r.description::json->>'itemIndex' = '12'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '鞋带衣饰框', 'Lacing Frame',
       'prek', 'montessori', 'practical_life', 'courseware',
       '照顾自己', 'published', t.id, '{"category": "照顾自己", "categoryEn": "Care of Oneself", "itemType": "lesson", "itemIndex": 13, "title": "鞋带衣饰框", "titleEn": "Lacing Frame", "slide": 131, "age": "3+", "aim": "发展专注力、协调性、独立性和秩序感", "aimEn": "Develop concentration, coordination, independence and a sense of orde", "language": "鞋带已解开，衣饰框已经打开", "languageEn": "The shoelace is untied; The dressing frame is open"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'practical_life'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '照顾自己'
      AND r.title = '鞋带衣饰框'
      AND r.description::json->>'itemIndex' = '13'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '安全别针衣饰框', 'Safety Pin Frame',
       'prek', 'montessori', 'practical_life', 'courseware',
       '照顾自己', 'published', t.id, '{"category": "照顾自己", "categoryEn": "Care of Oneself", "itemType": "lesson", "itemIndex": 14, "title": "安全别针衣饰框", "titleEn": "Safety Pin Frame", "slide": 133, "age": "3+", "aim": "发展专注力、协调性、独立性和秩序感", "aimEn": "Develop concentration, coordination, independence and a sense of order", "language": "我把别针打开了；对准；别针扣好了", "languageEn": "I opened the pin; Align; The pin is fastened"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'practical_life'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '照顾自己'
      AND r.title = '安全别针衣饰框'
      AND r.description::json->>'itemIndex' = '14'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '切香蕉', 'Peeling and Cutting a Banana',
       'prek', 'montessori', 'practical_life', 'courseware',
       '食物制备', 'published', t.id, '{"category": "食物制备", "categoryEn": "Food Preparation", "itemType": "lesson", "itemIndex": 1, "title": "切香蕉", "titleEn": "Peeling and Cutting a Banana", "slide": 136, "age": "3+", "aim": "发展幼儿动作协调性", "aimEn": "To develop the child''s motor coordination.", "language": "香蕉、切、夹、剥皮", "languageEn": "Banana, cut, tongs, peel."}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'practical_life'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '食物制备'
      AND r.title = '切香蕉'
      AND r.description::json->>'itemIndex' = '1'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '榨橙汁', 'Squeezing orange juice',
       'prek', 'montessori', 'practical_life', 'courseware',
       '食物制备', 'published', t.id, '{"category": "食物制备", "categoryEn": "Food Preparation", "itemType": "lesson", "itemIndex": 2, "title": "榨橙汁", "titleEn": "Squeezing orange juice", "slide": 138, "age": "3+", "aim": "发展幼儿手部控制力和力量，培养独立性和专注力", "aimEn": "To develop the child''s hand control and strength, and to foster independence and concentration.", "language": "榨、清洗", "languageEn": "Squeeze, clean"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'practical_life'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '食物制备'
      AND r.title = '榨橙汁'
      AND r.description::json->>'itemIndex' = '2'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '涂抹面包', 'Buttering/Jam Bread',
       'prek', 'montessori', 'practical_life', 'courseware',
       '食物制备', 'published', t.id, '{"category": "食物制备", "categoryEn": "Food Preparation", "itemType": "lesson", "itemIndex": 3, "title": "涂抹面包", "titleEn": "Buttering/Jam Bread", "slide": 140, "age": "3+", "aim": "发展幼儿手部控制力和力量，培养独立性和专注力", "aimEn": "To develop the child''s hand control and strength, and to foster independence and concentration.", "language": "果酱、涂抹、面包", "languageEn": "Jam, spread, bread"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'practical_life'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '食物制备'
      AND r.title = '涂抹面包'
      AND r.description::json->>'itemIndex' = '3'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '剥鸡蛋（蒜、橘子、石榴）', 'Cracking',
       'prek', 'montessori', 'practical_life', 'courseware',
       '食物制备', 'published', t.id, '{"category": "食物制备", "categoryEn": "Food Preparation", "itemType": "lesson", "itemIndex": 4, "title": "剥鸡蛋（蒜、橘子、石榴）", "titleEn": "Cracking", "slide": 142, "age": "3+", "aim": "发展幼儿手部控制力和力量，培养独立性和专注力", "aimEn": "To develop the child''s hand control and strength, and to foster independence and concentration.", "language": "剥，切，敲击鸡蛋、滚动", "languageEn": "Peel, slice, tap the egg, roll."}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'practical_life'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '食物制备'
      AND r.title = '剥鸡蛋（蒜、橘子、石榴）'
      AND r.description::json->>'itemIndex' = '4'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '泡茶', 'Making tea',
       'prek', 'montessori', 'practical_life', 'courseware',
       '食物制备', 'published', t.id, '{"category": "食物制备", "categoryEn": "Food Preparation", "itemType": "lesson", "itemIndex": 5, "title": "泡茶", "titleEn": "Making tea", "slide": 144, "age": "4+", "aim": "发展幼儿手部控制力和力量，培养独立性和专注力", "aimEn": "To develop the child''s hand control and strength, and to foster independence and concentration.", "language": "倒、热水、茶包、计时", "languageEn": "Pour, hot water, tea bag, timer."}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'practical_life'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '食物制备'
      AND r.title = '泡茶'
      AND r.description::json->>'itemIndex' = '5'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '照顾动物（如何人道地喂养动物，如小鸟投食器）', 'Feed Animal',
       'prek', 'montessori', 'practical_life', 'courseware',
       '照顾生命', 'published', t.id, '{"category": "照顾生命", "categoryEn": "Care of Life", "itemType": "lesson", "itemIndex": 1, "title": "照顾动物（如何人道地喂养动物，如小鸟投食器）", "titleEn": "Feed Animal", "slide": 147, "age": "3+", "aim": "发展幼儿动作协调性，培养照顾环境与环境中的动物的意识", "aimEn": "Control & coordination of movement, sense of caring the environment and the animals", "language": "动物名称", "languageEn": "Animal name"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'practical_life'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '照顾生命'
      AND r.title = '照顾动物（如何人道地喂养动物，如小鸟投食器）'
      AND r.description::json->>'itemIndex' = '1'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '插座圆柱体', 'Knobbed Cylinders',
       'prek', 'montessori', 'sensorial', 'courseware',
       '视觉', 'published', t.id, '{"category": "视觉", "categoryEn": "Sight", "itemType": "lesson", "itemIndex": 1, "title": "插座圆柱体", "titleEn": "Knobbed Cylinders", "slide": 154, "age": "2.5-3", "aim": "训练幼儿对尺寸的视觉辨别能力", "aimEn": "Visual discrimination of dimensions", "language": "大-小，粗-细，高-矮（比较级-更...，最高级-最...）；插座圆柱体，拿取，对比，顺序", "languageEn": "Big-Small Thick-Thin Tall-Short (plus comparatives & superlatives) Knobbed cylinders, carry, compare, sequence"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'sensorial'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '视觉'
      AND r.title = '插座圆柱体'
      AND r.description::json->>'itemIndex' = '1'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '粉红塔', 'Tower of Cubes',
       'prek', 'montessori', 'sensorial', 'courseware',
       '视觉', 'published', t.id, '{"category": "视觉", "categoryEn": "Sight", "itemType": "lesson", "itemIndex": 2, "title": "粉红塔", "titleEn": "Tower of Cubes", "slide": 156, "age": "2.5-4", "aim": "训练幼儿对大小的视觉辨别能力", "aimEn": "Visual discrimination of dimensions", "language": "大-小（比较级-更...，最高级-最...）；粉红塔，立（正）方体，拿取，对比，顺序", "languageEn": "Big-Small (plus comparatives & superlatives) Cube, carry, compare, sequence"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'sensorial'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '视觉'
      AND r.title = '粉红塔'
      AND r.description::json->>'itemIndex' = '2'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '棕色梯', 'Broad Stair',
       'prek', 'montessori', 'sensorial', 'courseware',
       '视觉', 'published', t.id, '{"category": "视觉", "categoryEn": "Sight", "itemType": "lesson", "itemIndex": 3, "title": "棕色梯", "titleEn": "Broad Stair", "slide": 158, "age": "2.5-4", "aim": "训练幼儿对粗细度的视觉辨别能力", "aimEn": "Visual discrimination of dimensions", "language": "粗-细，宽-窄（比较级-更...，最高级-最...）；棕色梯，拿取，对比，顺序", "languageEn": "Thick-Thin or Broad-Narrow (plus comparatives & superlatives) Stair, carry, compare, sequence"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'sensorial'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '视觉'
      AND r.title = '棕色梯'
      AND r.description::json->>'itemIndex' = '3'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '红棒', 'Length Rods',
       'prek', 'montessori', 'sensorial', 'courseware',
       '视觉', 'published', t.id, '{"category": "视觉", "categoryEn": "Sight", "itemType": "lesson", "itemIndex": 4, "title": "红棒", "titleEn": "Length Rods", "slide": 160, "age": "3.5+", "aim": "训练幼儿对长度的视觉辨别能力", "aimEn": "Visual discrimination of dimensions", "language": "长-短（比较级-更...，最高级-最...）；红棒，拿取，对比，顺序", "languageEn": "Long-Shortl (plus comparatives & superlatives) Length, carry, compare, sequence"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'sensorial'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '视觉'
      AND r.title = '红棒'
      AND r.description::json->>'itemIndex' = '4'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '彩色圆柱体', 'Knobless Cylinders',
       'prek', 'montessori', 'sensorial', 'courseware',
       '视觉', 'published', t.id, '{"category": "视觉", "categoryEn": "Sight", "itemType": "lesson", "itemIndex": 5, "title": "彩色圆柱体", "titleEn": "Knobless Cylinders", "slide": 162, "age": "3.5-4.5", "aim": "对不同尺寸进行对比与观察", "aimEn": "Observe & compare the various sets with each other", "language": "大-小，粗-细，高-矮（比较级-更...，最高级-最...）；插座圆柱体，无握钮", "languageEn": "Big-Small Thick-Thin Tall-Short (plus comparatives & superlatives) Knobless cylinders"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'sensorial'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '视觉'
      AND r.title = '彩色圆柱体'
      AND r.description::json->>'itemIndex' = '5'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '色板1', 'Color Box1',
       'prek', 'montessori', 'sensorial', 'courseware',
       '视觉', 'published', t.id, '{"category": "视觉", "categoryEn": "Sight", "itemType": "lesson", "itemIndex": 6, "title": "色板1", "titleEn": "Color Box1", "slide": 164, "age": "2.5-3", "aim": "认识三原色", "aimEn": "Learn about the primary colors", "language": "红色，黄色，蓝色", "languageEn": "Red Yellow Blue"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'sensorial'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '视觉'
      AND r.title = '色板1'
      AND r.description::json->>'itemIndex' = '6'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '色板2', 'Color Box2',
       'prek', 'montessori', 'sensorial', 'courseware',
       '视觉', 'published', t.id, '{"category": "视觉", "categoryEn": "Sight", "itemType": "lesson", "itemIndex": 7, "title": "色板2", "titleEn": "Color Box2", "slide": 166, "age": "2.5-4.5", "aim": "认识11种颜色", "aimEn": "Learn about 11 colors", "language": "红、黄、蓝、绿、橙、紫、灰、棕、粉、黑、白色", "languageEn": "Green, orange, purple, red, blue, yellow, gray, brown, pink, white, black"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'sensorial'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '视觉'
      AND r.title = '色板2'
      AND r.description::json->>'itemIndex' = '7'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '色板2', 'Color Box3',
       'prek', 'montessori', 'sensorial', 'courseware',
       '视觉', 'published', t.id, '{"category": "视觉", "categoryEn": "Sight", "itemType": "lesson", "itemIndex": 8, "title": "色板2", "titleEn": "Color Box3", "slide": 168, "age": "5+", "aim": "认识种颜色的深浅", "aimEn": "Learn about the gradation of colors", "language": "红、黄、蓝、绿、橙、紫、棕、粉、黑；深、浅，更深、更浅，最深、最浅", "languageEn": "Green, orange, purple, red, blue, yellow, gray, brown, pink, white, black Light-lighter-lightest Dark-darker-darkest"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'sensorial'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '视觉'
      AND r.title = '色板2'
      AND r.description::json->>'itemIndex' = '8'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '几何立体组', 'Geometric Solids',
       'prek', 'montessori', 'sensorial', 'courseware',
       '视觉', 'published', t.id, '{"category": "视觉", "categoryEn": "Sight", "itemType": "lesson", "itemIndex": 9, "title": "几何立体组", "titleEn": "Geometric Solids", "slide": 170, "age": "3+", "aim": "发展实体觉，认识不同的几何体", "aimEn": "Refine the child''s stereognostic sense", "language": "圆柱体，圆锥体，正方体，球体，长方体，三棱柱，三棱锥，四棱锥，椭圆体，卵体", "languageEn": "Cylinder, cube, ellipsoid, cone, sphere, square, prism, ovoid, triangular pyramid, triangular prism"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'sensorial'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '视觉'
      AND r.title = '几何立体组'
      AND r.description::json->>'itemIndex' = '9'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '几何立体组与投影板', 'Geometric Solids with Cards',
       'prek', 'montessori', 'sensorial', 'courseware',
       '视觉', 'published', t.id, '{"category": "视觉", "categoryEn": "Sight", "itemType": "lesson", "itemIndex": 10, "title": "几何立体组与投影板", "titleEn": "Geometric Solids with Cards", "slide": 172, "age": "3+", "aim": "认识不同的几何体和它们的底", "aimEn": "Refine the child''s stereognostic sense and learn the base of different solids", "language": "底，正方形，长方形，圆形，三角形", "languageEn": "Base, rectangle, equilateral triangle, acute-angled isosceles triangle, square, circle"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'sensorial'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '视觉'
      AND r.title = '几何立体组与投影板'
      AND r.description::json->>'itemIndex' = '10'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '立体几何神秘袋', 'Stereognostic Bag',
       'prek', 'montessori', 'sensorial', 'courseware',
       '视觉', 'published', t.id, '{"category": "视觉", "categoryEn": "Sight", "itemType": "lesson", "itemIndex": 11, "title": "立体几何神秘袋", "titleEn": "Stereognostic Bag", "slide": 174, "age": "3-4岁", "aim": "寻找到相同的立体几何组进行配对，发展孩子的立体触觉", "aimEn": "To find matching solid geometric shapes by touch, developing the child’s stereognostic (tactile) sense.", "language": "配对、立体几何组的名称、各种物品的名称", "languageEn": "Pair, match, names of solid geometric forms (e.g., sphere, cube, cone, cylinder), and names of the various objects."}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'sensorial'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '视觉'
      AND r.title = '立体几何神秘袋'
      AND r.description::json->>'itemIndex' = '11'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '几何图橱', 'Geometric Cabinet',
       'prek', 'montessori', 'sensorial', 'courseware',
       '视觉', 'published', t.id, '{"category": "视觉", "categoryEn": "Sight", "itemType": "lesson", "itemIndex": 12, "title": "几何图橱", "titleEn": "Geometric Cabinet", "slide": 176, "age": "2.5-5", "aim": "精化、辨别封闭图形的能力", "aimEn": "Purpose: To refine and distinguish closed figures.", "language": "嵌板、圆形、三角形、长方形、正方形、菱形、六边形、梯形、椭圆形", "languageEn": "insets, circle, triangle, rectangle, square, rhombus, hexagon, trapezoid, oval."}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'sensorial'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '视觉'
      AND r.title = '几何图橱'
      AND r.description::json->>'itemIndex' = '12'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '几何图橱和对应卡', 'Geometric Cabinet and Cards',
       'prek', 'montessori', 'sensorial', 'courseware',
       '视觉', 'published', t.id, '{"category": "视觉", "categoryEn": "Sight", "itemType": "lesson", "itemIndex": 13, "title": "几何图橱和对应卡", "titleEn": "Geometric Cabinet and Cards", "slide": 178, "age": "3.5-5岁", "aim": "精化比较、对比、辨别、配对的能力", "aimEn": "Purpose: To refine the abilities of comparing, contrasting, distinguishing, and matching.", "language": "形状名称、实心图卡、粗线图卡、细线图卡", "languageEn": "Shape names, solid cards, thick-line cards, thin-line cards."}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'sensorial'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '视觉'
      AND r.title = '几何图橱和对应卡'
      AND r.description::json->>'itemIndex' = '13'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '长方形盒1', 'Rectangle Box A',
       'prek', 'montessori', 'sensorial', 'courseware',
       '视觉', 'published', t.id, '{"category": "视觉", "categoryEn": "Sight", "itemType": "lesson", "itemIndex": 14, "title": "长方形盒1", "titleEn": "Rectangle Box A", "slide": 180, "age": "4-5岁", "aim": "学习和探索用三角形构建不同的几何图形", "aimEn": "To learn and explore constructing different geometric shapes using triangles", "language": "对齐、正方形、长方形、平行四边形、菱形、梯形", "languageEn": "Align, square, rectangle, parallelogram, rhombus, trapezoid."}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'sensorial'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '视觉'
      AND r.title = '长方形盒1'
      AND r.description::json->>'itemIndex' = '14'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '长方形盒2/蓝色三角形盒', 'Rectangle Box B',
       'prek', 'montessori', 'sensorial', 'courseware',
       '视觉', 'published', t.id, '{"category": "视觉", "categoryEn": "Sight", "itemType": "lesson", "itemIndex": 15, "title": "长方形盒2/蓝色三角形盒", "titleEn": "Rectangle Box B", "slide": 182, "age": "4-5岁", "aim": "探索新的形状，得到新的发现", "aimEn": "Purpose: To explore new shapes and make new discoveries.", "language": "正方形、长方形、平行四边形、菱形、梯形", "languageEn": "square, rectangle, parallelogram, rhombus, trapezoid."}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'sensorial'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '视觉'
      AND r.title = '长方形盒2/蓝色三角形盒'
      AND r.description::json->>'itemIndex' = '15'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '三角形盒', 'Triangle Box',
       'prek', 'montessori', 'sensorial', 'courseware',
       '视觉', 'published', t.id, '{"category": "视觉", "categoryEn": "Sight", "itemType": "lesson", "itemIndex": 16, "title": "三角形盒", "titleEn": "Triangle Box", "slide": 184, "age": "4-5岁", "aim": "精化观察、认识相似形、相同性和解决问题的能力", "aimEn": "Purpose: To refine observation, recognize similar shapes, identify similarities, and solve problems.", "language": "灰色三角形：底、边、角；绿色三角形：高、顶点；黄色三角形：角平分线；红色三角形：中点", "languageEn": "Gray triangle: base, side, angle；Green triangle: height, vertex；Yellow triangle: angle bisector；Red triangle: midpoint"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'sensorial'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '视觉'
      AND r.title = '三角形盒'
      AND r.description::json->>'itemIndex' = '16'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '大六边形盒', 'Large Hexagonal Box',
       'prek', 'montessori', 'sensorial', 'courseware',
       '视觉', 'published', t.id, '{"category": "视觉", "categoryEn": "Sight", "itemType": "lesson", "itemIndex": 17, "title": "大六边形盒", "titleEn": "Large Hexagonal Box", "slide": 186, "age": "4-5岁", "aim": "用盒中三角形组合几何图形", "aimEn": "Purpose: To combine the triangles from the box to form geometric shapes.", "language": "菱形、等腰梯形、等边三角形、六边形", "languageEn": "Rhombus, isosceles trapezoid, equilateral triangle, hexagon."}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'sensorial'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '视觉'
      AND r.title = '大六边形盒'
      AND r.description::json->>'itemIndex' = '17'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '小六边形盒', 'Small Hexagonal Box',
       'prek', 'montessori', 'sensorial', 'courseware',
       '视觉', 'published', t.id, '{"category": "视觉", "categoryEn": "Sight", "itemType": "lesson", "itemIndex": 18, "title": "小六边形盒", "titleEn": "Small Hexagonal Box", "slide": 188, "age": "4-5岁", "aim": "寻找盒中三角形和六边形的关系精化观察、相似性、差异性、逻辑分析、推理判断和解决问题的能力", "aimEn": "Purpose:To explore the relationship between the triangles in the box and the hexagon.", "language": "菱形、等腰梯形、六边形、等边三角形", "languageEn": "Rhombus, isosceles trapezoid, hexagon, equilateral triangle."}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'sensorial'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '视觉'
      AND r.title = '小六边形盒'
      AND r.description::json->>'itemIndex' = '18'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '蓝色三角形盒', 'Constructive Blue Triangles',
       'prek', 'montessori', 'sensorial', 'courseware',
       '视觉', 'published', t.id, '{"category": "视觉", "categoryEn": "Sight", "itemType": "lesson", "itemIndex": 19, "title": "蓝色三角形盒", "titleEn": "Constructive Blue Triangles", "slide": 190, "age": "在尝试所有三角形盒后", "aim": "自由探索、组合三角形", "aimEn": "Purpose: Exploration", "language": "无", "languageEn": "/"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'sensorial'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '视觉'
      AND r.title = '蓝色三角形盒'
      AND r.description::json->>'itemIndex' = '19'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '二项式', 'Binomial Cube',
       'prek', 'montessori', 'sensorial', 'courseware',
       '视觉', 'published', t.id, '{"category": "视觉", "categoryEn": "Sight", "itemType": "lesson", "itemIndex": 20, "title": "二项式", "titleEn": "Binomial Cube", "slide": 192, "age": "3.5-4岁", "aim": "有效地构建二项式立方体；介绍代数", "aimEn": "Purpose: To effectively construct the binomial cube; introduction to algebra.", "language": "二项式、立方体、分类、盖子", "languageEn": "Binomial, cube, classification, lid"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'sensorial'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '视觉'
      AND r.title = '二项式'
      AND r.description::json->>'itemIndex' = '20'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '三项式', 'Trinomial Cube',
       'prek', 'montessori', 'sensorial', 'courseware',
       '视觉', 'published', t.id, '{"category": "视觉", "categoryEn": "Sight", "itemType": "lesson", "itemIndex": 21, "title": "三项式", "titleEn": "Trinomial Cube", "slide": 194, "age": "4-5岁", "aim": "精化观察、比较、推理的能力", "aimEn": "Refine the abilities of observation, comparison, and reasoning.", "language": "三项式、立方体、分类、盖子", "languageEn": "Trinomial, Cube, Classification, Lid"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'sensorial'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '视觉'
      AND r.title = '三项式'
      AND r.description::json->>'itemIndex' = '21'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '听音筒', 'Sound Cylinders Two wooden boxes, one with a red lid and one with a blue lid. Each box contains six empty wooden cylindrical tubes, with the tubes in the red box having red lids and those in the blue box having blue lids. Each cylinder is sealed with a sm',
       'prek', 'montessori', 'sensorial', 'courseware',
       '听觉', 'published', t.id, '{"category": "听觉", "categoryEn": "Hearing", "itemType": "lesson", "itemIndex": 1, "title": "听音筒", "titleEn": "Sound Cylinders Two wooden boxes, one with a red lid and one with a blue lid. Each box contains six empty wooden cylindrical tubes, with the tubes in the red box having red lids and those in the blue box having blue lids. Each cylinder is sealed with a small amount of sand, rice, pebbles, beans, or beads. When shaken, the cylinders produce distinct sounds ranging from loud to soft.", "slide": 197, "age": "3.5+", "aim": "精炼和完善孩子的观察、比较、辨别的能力。", "aimEn": "To refine and enhance the child’s ability to observe, compare, and discriminate.", "language": "大声的、轻柔的、相同的、不同的、更大声的、更轻柔的。", "languageEn": "Loud, soft, same, different, louder, softer."}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'sensorial'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '听觉'
      AND r.title = '听音筒'
      AND r.description::json->>'itemIndex' = '1'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '音感钟', 'Montessori Auditory Bells',
       'prek', 'montessori', 'sensorial', 'courseware',
       '听觉', 'published', t.id, '{"category": "听觉", "categoryEn": "Hearing", "itemType": "lesson", "itemIndex": 2, "title": "音感钟", "titleEn": "Montessori Auditory Bells", "slide": 199, "age": "3+", "aim": "精炼和完善孩子的观察、比较的能力。", "aimEn": "To refine and enhance the child''s ability to observe and compare.", "language": "相同的、不同的、高音、低音、最高、最低。", "languageEn": "Same, different, high pitch, low pitch, highest, lowest."}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'sensorial'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '听觉'
      AND r.title = '音感钟'
      AND r.description::json->>'itemIndex' = '2'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '触觉板（一）', 'The Touch Boards 1',
       'prek', 'montessori', 'sensorial', 'courseware',
       '触觉', 'published', t.id, '{"category": "触觉", "categoryEn": "Touch", "itemType": "lesson", "itemIndex": 1, "title": "触觉板（一）", "titleEn": "The Touch Boards 1", "slide": 202, "age": "3+", "aim": "学习认识分辨物体的粗糙与光滑。", "aimEn": "To learn to recognize and distinguish between rough and smooth textures.", "language": "粗糙、光滑", "languageEn": "Rough, smooth"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'sensorial'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '触觉'
      AND r.title = '触觉板（一）'
      AND r.description::json->>'itemIndex' = '1'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '触觉板（二）', 'The Touch Boards 2',
       'prek', 'montessori', 'sensorial', 'courseware',
       '触觉', 'published', t.id, '{"category": "触觉", "categoryEn": "Touch", "itemType": "lesson", "itemIndex": 2, "title": "触觉板（二）", "titleEn": "The Touch Boards 2", "slide": 204, "age": "3+", "aim": "感觉从粗糙到更粗糙的能力。", "aimEn": "To develop the ability to perceive differences in roughness, from slightly rough to much rougher textures.", "language": "粗糙、较粗糙、最粗糙。", "languageEn": "Rough, rougher, roughest."}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'sensorial'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '触觉'
      AND r.title = '触觉板（二）'
      AND r.description::json->>'itemIndex' = '2'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '触觉配对板', 'Tactile Matching Boards',
       'prek', 'montessori', 'sensorial', 'courseware',
       '触觉', 'published', t.id, '{"category": "触觉", "categoryEn": "Touch", "itemType": "lesson", "itemIndex": 3, "title": "触觉配对板", "titleEn": "Tactile Matching Boards", "slide": 206, "age": "3+", "aim": "比较、配对不同粗糙感的能力。", "aimEn": "To develop the ability to compare and match different levels of roughness.", "language": "粗糙、光滑、更粗糙", "languageEn": "Rough, smooth, rougher."}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'sensorial'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '触觉'
      AND r.title = '触觉配对板'
      AND r.description::json->>'itemIndex' = '3'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '布盒', 'Fabric Box',
       'prek', 'montessori', 'sensorial', 'courseware',
       '触觉', 'published', t.id, '{"category": "触觉", "categoryEn": "Touch", "itemType": "lesson", "itemIndex": 4, "title": "布盒", "titleEn": "Fabric Box", "slide": 208, "age": "3+", "aim": "感觉布料，完成两个布盒中相同布料的配对。", "aimEn": "To sense different fabrics and match identical fabric pieces from two fabric boxes.", "language": "粗糙、光滑、更粗糙", "languageEn": "Rough, smooth, rougher."}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'sensorial'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '触觉'
      AND r.title = '布盒'
      AND r.description::json->>'itemIndex' = '4'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '重量板', 'Weight Tablets',
       'prek', 'montessori', 'sensorial', 'courseware',
       '触觉', 'published', t.id, '{"category": "触觉", "categoryEn": "Touch", "itemType": "lesson", "itemIndex": 5, "title": "重量板", "titleEn": "Weight Tablets", "slide": 210, "age": "3.5+", "aim": "培养幼儿辨别重量的感觉。", "aimEn": "To cultivate the child''s ability to perceive and differentiate weights.", "language": "轻、重、中等、重量", "languageEn": "Light, heavy, medium, weight."}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'sensorial'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '触觉'
      AND r.title = '重量板'
      AND r.description::json->>'itemIndex' = '5'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '温觉板', 'Thermic Tablets',
       'prek', 'montessori', 'sensorial', 'courseware',
       '触觉', 'published', t.id, '{"category": "触觉", "categoryEn": "Touch", "itemType": "lesson", "itemIndex": 6, "title": "温觉板", "titleEn": "Thermic Tablets", "slide": 212, "age": "3.5+", "aim": "培养幼儿对温度的分辨能力。", "aimEn": "To cultivate the child’s ability to distinguish differences in temperature.", "language": "温度、暖的、冷的、温的。", "languageEn": "Temperature, warm, cold, tepid."}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'sensorial'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '触觉'
      AND r.title = '温觉板'
      AND r.description::json->>'itemIndex' = '6'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '温觉瓶', 'Thermic Bottles',
       'prek', 'montessori', 'sensorial', 'courseware',
       '触觉', 'published', t.id, '{"category": "触觉", "categoryEn": "Touch", "itemType": "lesson", "itemIndex": 7, "title": "温觉瓶", "titleEn": "Thermic Bottles", "slide": 214, "age": "3+", "aim": "培养对温度差异的感官辨别能力。", "aimEn": "To cultivate the ability to discern differences in temperature.", "language": "温度、暖的、冷的、温的。", "languageEn": "Temperature, warm, cold, tepid."}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'sensorial'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '触觉'
      AND r.title = '温觉瓶'
      AND r.description::json->>'itemIndex' = '7'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '嗅觉瓶', 'Smelling Bottles',
       'prek', 'montessori', 'sensorial', 'courseware',
       '嗅觉', 'published', t.id, '{"category": "嗅觉", "categoryEn": "Smell", "itemType": "lesson", "itemIndex": 1, "title": "嗅觉瓶", "titleEn": "Smelling Bottles", "slide": 217, "age": "3.5+", "aim": "发展嗅觉辨别能力与感官专注力。", "aimEn": "To develop olfactory discrimination and sensory concentration.", "language": "香的、清新的、浓郁的、刺鼻的。", "languageEn": "Fragrant, fresh, strong, pungent."}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'sensorial'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '嗅觉'
      AND r.title = '嗅觉瓶'
      AND r.description::json->>'itemIndex' = '1'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '味觉瓶', 'Tasting Bottles',
       'prek', 'montessori', 'sensorial', 'courseware',
       '味觉', 'published', t.id, '{"category": "味觉", "categoryEn": "Taste", "itemType": "lesson", "itemIndex": 1, "title": "味觉瓶", "titleEn": "Tasting Bottles", "slide": 220, "age": "3.5+", "aim": "发展味觉辨别能力，识别四种基本味道。", "aimEn": "To develop taste discrimination and recognize the four basic tastes.", "language": "甜的、咸的、酸的、苦的、味道、", "languageEn": "Sweet, salty, sour, bitter, taste."}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'sensorial'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '味觉'
      AND r.title = '味觉瓶'
      AND r.description::json->>'itemIndex' = '1'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '数棒', 'Number Rods',
       'prek', 'montessori', 'math', 'courseware',
       '数字 1–10', 'published', t.id, '{"category": "数字 1–10", "categoryEn": "数字 1–10 Number to Ten", "itemType": "lesson", "itemIndex": 1, "title": "数棒", "titleEn": "Number Rods", "slide": 227, "age": "3.5+", "aim": "学习数字1-10的量与数字的名称", "aimEn": "To learn the quantities and names of numbers 1-10", "language": "数字名称，从最长到最短，这是“1”，我来数“1，2，3...”", "languageEn": "From longest to the shortest. This is \"1\", I am going to count it. one, two, three......"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'math'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '数字 1–10'
      AND r.title = '数棒'
      AND r.description::json->>'itemIndex' = '1'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '砂纸数字板', 'Sandpaper Numbers',
       'prek', 'montessori', 'math', 'courseware',
       '数字 1–10', 'published', t.id, '{"category": "数字 1–10", "categoryEn": "数字 1–10 Number to Ten", "itemType": "lesson", "itemIndex": 2, "title": "砂纸数字板", "titleEn": "Sandpaper Numbers", "slide": 229, "age": "3.5+", "aim": "通过手和脑的协调活动创建数学性心智，意识到数字是一种代表量的书写符号", "aimEn": "To create a mathematical mind through the coordinated activity of hands and brain, and to realize that numbers are written symbols representing quantities", "language": "数字名称，“我们按顺序写出数字”", "languageEn": "One, two, three...Let''s write them in sequence"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'math'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '数字 1–10'
      AND r.title = '砂纸数字板'
      AND r.description::json->>'itemIndex' = '2'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '数棒与数字卡', 'Number Rods and Cards',
       'prek', 'montessori', 'math', 'courseware',
       '数字 1–10', 'published', t.id, '{"category": "数字 1–10", "categoryEn": "数字 1–10 Number to Ten", "itemType": "lesson", "itemIndex": 3, "title": "数棒与数字卡", "titleEn": "Number Rods and Cards", "slide": 231, "age": "3.5+", "aim": "数量1-10和数字符号1-10的结合", "aimEn": "Matching quantities 1-10 and numerical symbols 1-10", "language": "这是多少？6；请你去拿6；请你数一下；我们一起来读数字1-10；我们一起读10-1；9怎样才能和10一样长？现在它们一样长了；9和1合起来和10一样长，如…", "languageEn": "What is this?-6; Can you go and bring number 6; Can you count it Let''s read the numbers(1-10); Let''s read them backwards(10-1); How can we make No.9 as long as No.10? Now they are in the same length; Since 9 and 1make 10, So what happen if we take away 1?"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'math'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '数字 1–10'
      AND r.title = '数棒与数字卡'
      AND r.description::json->>'itemIndex' = '3'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '纺锤棒箱', 'Spindle Box',
       'prek', 'montessori', 'math', 'courseware',
       '数字 1–10', 'published', t.id, '{"category": "数字 1–10", "categoryEn": "数字 1–10 Number to Ten", "itemType": "lesson", "itemIndex": 4, "title": "纺锤棒箱", "titleEn": "Spindle Box", "slide": 233, "age": "3.5+", "aim": "帮助孩子认识符号与其对应的量", "aimEn": "Understand symbols and their corresponding quantities", "language": "这是零，零的意思是没有", "languageEn": "This is Zero, zero means nothing"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'math'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '数字 1–10'
      AND r.title = '纺锤棒箱'
      AND r.description::json->>'itemIndex' = '4'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '数字记忆游戏', 'Momory Game of Numbers',
       'prek', 'montessori', 'math', 'courseware',
       '数字 1–10', 'published', t.id, '{"category": "数字 1–10", "categoryEn": "数字 1–10 Number to Ten", "itemType": "lesson", "itemIndex": 5, "title": "数字记忆游戏", "titleEn": "Momory Game of Numbers", "slide": 235, "age": "3.5+", "aim": "数字1-10计数，回忆数字并找到其相对应的数量", "aimEn": "Count numbers 1-10, recall the numbers and find their corresponding quantities", "language": "/", "languageEn": "/"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'math'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '数字 1–10'
      AND r.title = '数字记忆游戏'
      AND r.description::json->>'itemIndex' = '5'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '数字与筹码', 'Numbers and Counters',
       'prek', 'montessori', 'math', 'courseware',
       '数字 1–10', 'published', t.id, '{"category": "数字 1–10", "categoryEn": "数字 1–10 Number to Ten", "itemType": "lesson", "itemIndex": 6, "title": "数字与筹码", "titleEn": "Numbers and Counters", "slide": 237, "age": "3.5+", "aim": "继续练习计数，按顺序正确地计数", "aimEn": "Continue practicing counting, counting in the correct order", "language": "这里有一些数字与筹码；让我们把这些数字按顺序排列；这里有0和1，我们把它们组合成10；在数字1下面放一个筹码；在数字2下面并排放两个筹码；奇数，偶数", "languageEn": "We have some counter and nombers here; Let''s place the numbers in sequence; We have zero and one here, let''s make them become 10; Put one counter under number 1; Put two counters in a horizonal row under number 2; Even numbers; Odd numbers"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'math'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '数字 1–10'
      AND r.title = '数字与筹码'
      AND r.description::json->>'itemIndex' = '6'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '彩色串珠', 'Color Beads',
       'prek', 'montessori', 'math', 'courseware',
       '数字 1–10', 'published', t.id, '{"category": "数字 1–10", "categoryEn": "数字 1–10 Number to Ten", "itemType": "lesson", "itemIndex": 7, "title": "彩色串珠", "titleEn": "Color Beads", "slide": 239, "age": "3.5+", "aim": "将每种彩色串珠棒与其对应的数量联系起来", "aimEn": "Associate each colored bead with its corresponding quantity", "language": "/", "languageEn": "/"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'math'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '数字 1–10'
      AND r.title = '彩色串珠'
      AND r.description::json->>'itemIndex' = '7'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '塞根板1-串珠', 'Teen Board - Beads',
       'prek', 'montessori', 'math', 'courseware',
       '线性计数：十几和几十', 'published', t.id, '{"category": "线性计数：十几和几十", "categoryEn": "线性计数：十几和几十 Teens and Tens", "itemType": "lesson", "itemIndex": 1, "title": "塞根板1-串珠", "titleEn": "Teen Board - Beads", "slide": 242, "age": "3.5+", "aim": "学习11-19的数量", "aimEn": "Learn about the quantity of 11-19", "language": "9根10的串珠；1到9的彩色串珠各一；这里有彩色珠子", "languageEn": "9 ten bars; 1 of each colored beads from 1-9; We have color beads here; This is 3.1,2,3.You may count it; They make eleven; Can you count eleven?"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'math'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '线性计数：十几和几十'
      AND r.title = '塞根板1-串珠'
      AND r.description::json->>'itemIndex' = '1'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '塞根板1-数字卡', 'Teen Board - Number Cards',
       'prek', 'montessori', 'math', 'courseware',
       '线性计数：十几和几十', 'published', t.id, '{"category": "线性计数：十几和几十", "categoryEn": "线性计数：十几和几十 Teens and Tens", "itemType": "lesson", "itemIndex": 2, "title": "塞根板1-数字卡", "titleEn": "Teen Board - Number Cards", "slide": 244, "age": "3.5+", "aim": "学习数字11-19的符号命名", "aimEn": "Learn about the symbols of 11-19", "language": "两块有9个10的木板；我们有两块木板，我们有一些数字卡片；这是什么数字？这是10，这是1，它们组成11；请说11；你能组成11吗？", "languageEn": "2 boards numbered with 9 tens; We have 2 boards; We have some number cards; What number is this? It has 10 here.We put 1 here, it makes 11. Say 11. Can you make 11?"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'math'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '线性计数：十几和几十'
      AND r.title = '塞根板1-数字卡'
      AND r.description::json->>'itemIndex' = '2'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '塞根板1-对应', 'Teen Board - Matching',
       'prek', 'montessori', 'math', 'courseware',
       '线性计数：十几和几十', 'published', t.id, '{"category": "线性计数：十几和几十", "categoryEn": "线性计数：十几和几十 Teens and Tens", "itemType": "lesson", "itemIndex": 3, "title": "塞根板1-对应", "titleEn": "Teen Board - Matching", "slide": 246, "age": "3.5+", "aim": "学习11-19数量与符号的对应", "aimEn": "Matching the symbols and quantities of 11-19", "language": "这是10，这是1，它们组成11；你能用串珠组成11吗？", "languageEn": "This is 10, this is 1. They makes 11. Can you make this number with beads?"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'math'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '线性计数：十几和几十'
      AND r.title = '塞根板1-对应'
      AND r.description::json->>'itemIndex' = '3'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '塞根板2', 'Ten Board',
       'prek', 'montessori', 'math', 'courseware',
       '线性计数：十几和几十', 'published', t.id, '{"category": "线性计数：十几和几十", "categoryEn": "线性计数：十几和几十 Teens and Tens", "itemType": "lesson", "itemIndex": 4, "title": "塞根板2", "titleEn": "Ten Board", "slide": 248, "age": "3.5+", "aim": "阶段一：学习跳数10到90（结合数字板10-90）；阶段二：11-99的点数（进位）", "aimEn": "Stage1: Learning skip counting from 10-90 by using the beads and boards Stage2: Learning liner counting from 10-99 (carry over) by using the beads and boards", "language": "/", "languageEn": "/"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'math'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '线性计数：十几和几十'
      AND r.title = '塞根板2'
      AND r.description::json->>'itemIndex' = '4'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '十的平方链', 'Shrot-chain of 10',
       'prek', 'montessori', 'math', 'courseware',
       '线性计数：十几和几十', 'published', t.id, '{"category": "线性计数：十几和几十", "categoryEn": "线性计数：十几和几十 Teens and Tens", "itemType": "lesson", "itemIndex": 5, "title": "十的平方链", "titleEn": "Shrot-chain of 10", "slide": 250, "age": "3.5+", "aim": "学习跳数", "aimEn": "Learning skip counting", "language": "跳数；我们一起来看看第一节串珠，你能数数第一节有几颗珠子吗？我们一起来折一下，看看我们能折叠几次？这看起来像正方形吗？这看起来像正方体吗？是的，它们是一样的。", "languageEn": "Skip counting; Let''s see the first segment, can you count how many beads here? Let''s fold to see how many times we can fold it?\" Does it looks like a square? Dose it looks like this cube? Yes, they are the same."}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'math'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '线性计数：十几和几十'
      AND r.title = '十的平方链'
      AND r.description::json->>'itemIndex' = '5'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '一百板', 'One Hundred Board',
       'prek', 'montessori', 'math', 'courseware',
       '线性计数：十几和几十', 'published', t.id, '{"category": "线性计数：十几和几十", "categoryEn": "线性计数：十几和几十 Teens and Tens", "itemType": "lesson", "itemIndex": 6, "title": "一百板", "titleEn": "One Hundred Board", "slide": 252, "age": "3.5+", "aim": "练习线性计数，为数字1-100的排列顺序", "aimEn": "Practice linear counting, arranging numbers from 1-100 in order", "language": "/", "languageEn": "/"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'math'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '线性计数：十几和几十'
      AND r.title = '一百板'
      AND r.description::json->>'itemIndex' = '6'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '1-9的平方链', 'Short-chains of 1-9',
       'prek', 'montessori', 'math', 'courseware',
       '线性计数：十几和几十', 'published', t.id, '{"category": "线性计数：十几和几十", "categoryEn": "线性计数：十几和几十 Teens and Tens", "itemType": "lesson", "itemIndex": 7, "title": "1-9的平方链", "titleEn": "Short-chains of 1-9", "slide": 254, "age": "3.5+", "aim": "加强连续数1-100的概念并学习跳数", "aimEn": "Strengthen linear counting of numbers 1-100 and learn the concept of skip counting", "language": "/", "languageEn": "/"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'math'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '线性计数：十几和几十'
      AND r.title = '1-9的平方链'
      AND r.description::json->>'itemIndex' = '7'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '十的立方链', 'Long-chain of 10',
       'prek', 'montessori', 'math', 'courseware',
       '线性计数：十几和几十', 'published', t.id, '{"category": "线性计数：十几和几十", "categoryEn": "线性计数：十几和几十 Teens and Tens", "itemType": "lesson", "itemIndex": 8, "title": "十的立方链", "titleEn": "Long-chain of 10", "slide": 256, "age": "3.5+", "aim": "建立10的数字立方的概念", "aimEn": "Concept of building the cube of 10", "language": "我们手上要有五个环；我们要把串珠链折起来做成100的方块；让我们看看我们能做多少个100的方块；它们一样吗？所以我们可以这条串珠链做10个100的正方块—…", "languageEn": "We are going to have five rings on our hands; We are going to fold this chain to make 100 squares; Let''s see how many 100 squares can we make; Are they the same? So we can make ten 100 square with this chain-So this chain can make ten 100 squares and 0ne 1000 cube"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'math'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '线性计数：十几和几十'
      AND r.title = '十的立方链'
      AND r.description::json->>'itemIndex' = '8'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '1-5的立方链', 'Long-chains of 1-5',
       'prek', 'montessori', 'math', 'courseware',
       '线性计数：十几和几十', 'published', t.id, '{"category": "线性计数：十几和几十", "categoryEn": "线性计数：十几和几十 Teens and Tens", "itemType": "lesson", "itemIndex": 9, "title": "1-5的立方链", "titleEn": "Long-chains of 1-5", "slide": 258, "age": "3.5+", "aim": "建立1-5的数字立方的概念", "aimEn": "Concept of building cubes of numbers from 1 to 5", "language": "/", "languageEn": "/"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'math'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '线性计数：十几和几十'
      AND r.title = '1-5的立方链'
      AND r.description::json->>'itemIndex' = '9'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '十进制介绍-串珠', 'Introduction to the Decimal System(Beads)',
       'prek', 'montessori', 'math', 'courseware',
       '十进制系统介绍', 'published', t.id, '{"category": "十进制系统介绍", "categoryEn": "十进制系统介绍 Decimal System Introduction", "itemType": "lesson", "itemIndex": 1, "title": "十进制介绍-串珠", "titleEn": "Introduction to the Decimal System(Beads)", "slide": 261, "age": "4-5岁", "aim": "介绍十进位系统的位数，从感官上理解十进制系统的抽象性。", "aimEn": "To introduce the place values of the decimal system and help children perceptually understand the abstract nature of the decimal system.", "language": "个位、十位、百位、千位", "languageEn": "Units place, Tens place, Hundreds place, Thousands place"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'math'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '十进制系统介绍'
      AND r.title = '十进制介绍-串珠'
      AND r.description::json->>'itemIndex' = '1'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '十进制介绍-卡片符号', 'Introduction to the Decimal System(Cards)',
       'prek', 'montessori', 'math', 'courseware',
       '十进制系统介绍', 'published', t.id, '{"category": "十进制系统介绍", "categoryEn": "十进制系统介绍 Decimal System Introduction", "itemType": "lesson", "itemIndex": 2, "title": "十进制介绍-卡片符号", "titleEn": "Introduction to the Decimal System(Cards)", "slide": 263, "age": "4-5岁", "aim": "识别十进位系统个、十、百、千位数字的符号。", "aimEn": "To recognize the number symbols of the units, tens, hundreds and thousands places in the decimal system.", "language": "十进位系统各数位的名称", "languageEn": "Names of each place value in the decimal system"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'math'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '十进制系统介绍'
      AND r.title = '十进制介绍-卡片符号'
      AND r.description::json->>'itemIndex' = '2'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '十进制数量与数字卡的对应', 'Association of Decimal Beads to Decimal Cards',
       'prek', 'montessori', 'math', 'courseware',
       '十进制系统介绍', 'published', t.id, '{"category": "十进制系统介绍", "categoryEn": "十进制系统介绍 Decimal System Introduction", "itemType": "lesson", "itemIndex": 3, "title": "十进制数量与数字卡的对应", "titleEn": "Association of Decimal Beads to Decimal Cards", "slide": 265, "age": "4-5岁", "aim": "十进制系统中数量和符号的对应 ，并熟悉读法。", "aimEn": "To match quantities and symbols in the decimal system, and become familiar with their pronunciation.", "language": "十进位系统中的名称", "languageEn": "Nomenclature of the decimal system"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'math'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '十进制系统介绍'
      AND r.title = '十进制数量与数字卡的对应'
      AND r.description::json->>'itemIndex' = '3'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '“9”的托盘或交换游戏', 'Tray of Nines（9’s）/ Exchange Tray',
       'prek', 'montessori', 'math', 'courseware',
       '十进制系统介绍', 'published', t.id, '{"category": "十进制系统介绍", "categoryEn": "十进制系统介绍 Decimal System Introduction", "itemType": "lesson", "itemIndex": 4, "title": "“9”的托盘或交换游戏", "titleEn": "Tray of Nines（9’s）/ Exchange Tray", "slide": 267, "age": "4.5岁+", "aim": "逢九进十，意识到每个数位最多只能有9（如果这里再有1个1，它就是一个十。为儿童展示在某一数位中再增加一个单位，意味着数位可能发生变化（进位的概念）", "aimEn": "To show children that adding one more unit to any place value may cause a place value change (the concept of regrouping/ carry over).", "language": "银行、交换、数位名称", "languageEn": "Bank, exchange, place value names"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'math'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '十进制系统介绍'
      AND r.title = '“9”的托盘或交换游戏'
      AND r.description::json->>'itemIndex' = '4'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '1999的数量', 'Number of 1999',
       'prek', 'montessori', 'math', 'courseware',
       '十进制系统介绍', 'published', t.id, '{"category": "十进制系统介绍", "categoryEn": "十进制系统介绍 Decimal System Introduction", "itemType": "lesson", "itemIndex": 5, "title": "1999的数量", "titleEn": "Number of 1999", "slide": 269, "age": "4.5岁+", "aim": "认识1999的串珠数量，并学会如何读数", "aimEn": "Recognize bead quantities up to 1999 and master number reading.", "language": "“一个1读作1，两个1读作2……九个1读作9”、“一个10读作10，两个十读作20……九个十读作90”、“一个百读作100，两个百读作200……9个百读作…", "languageEn": "\"One unit is one, two units are two ... nine units are nine.\"\"One ten is ten, two tens are twenty ... nine tens are ninety.\"\"One hundred is one hundred, two hundreds are two hundred ... nine hundreds are nine hundred.\"\"One thousand.\""}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'math'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '十进制系统介绍'
      AND r.title = '1999的数量'
      AND r.description::json->>'itemIndex' = '5'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '1999的数字卡', 'Number Card of 1999',
       'prek', 'montessori', 'math', 'courseware',
       '十进制系统介绍', 'published', t.id, '{"category": "十进制系统介绍", "categoryEn": "十进制系统介绍 Decimal System Introduction", "itemType": "lesson", "itemIndex": 6, "title": "1999的数字卡", "titleEn": "Number Card of 1999", "slide": 271, "age": "4.5岁+", "aim": "抽象化预备；识别十进位系统中数量与数字符号的联系", "aimEn": "Preparation: for abstraction; establish the connection between quantities and numerical symbols in the decimal system.", "language": "数字1-10，10-90，100-900，1000的名称", "languageEn": "Number names from 1–9, 10–90, 100–900 and 1000."}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'math'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '十进制系统介绍'
      AND r.title = '1999的数字卡'
      AND r.description::json->>'itemIndex' = '6'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '1999数与量的对应', 'Quantity Extraction Exercise - 1999',
       'prek', 'montessori', 'math', 'courseware',
       '十进制系统介绍', 'published', t.id, '{"category": "十进制系统介绍", "categoryEn": "十进制系统介绍 Decimal System Introduction", "itemType": "lesson", "itemIndex": 7, "title": "1999数与量的对应", "titleEn": "Quantity Extraction Exercise - 1999", "slide": 273, "age": "4.5+", "aim": "串珠和卡片结合，帮助孩子向抽象过渡。知道数值可以由符号或者具体数量代表", "aimEn": "Objectives: Combine golden beads with number cards to help children transition from concrete to abstract thinking. Help children understand that numbers can be represented by symbols or physical quantities.", "language": "材料演示过程中的语言", "languageEn": "Verbal guidance during material demonstration"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'math'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '十进制系统介绍'
      AND r.title = '1999数与量的对应'
      AND r.description::json->>'itemIndex' = '7'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '45的排列-数量', '45 Layout（Beads）',
       'prek', 'montessori', 'math', 'courseware',
       '十进制系统介绍', 'published', t.id, '{"category": "十进制系统介绍", "categoryEn": "十进制系统介绍 Decimal System Introduction", "itemType": "lesson", "itemIndex": 8, "title": "45的排列-数量", "titleEn": "45 Layout（Beads）", "slide": 275, "age": "4.5岁+", "aim": "让儿童对十进制系统建立具象的感官印象", "aimEn": "Help children build a concrete sensory understanding of the decimal system.", "language": "这是……，这读作……", "languageEn": "This is..., This reads..."}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'math'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '十进制系统介绍'
      AND r.title = '45的排列-数量'
      AND r.description::json->>'itemIndex' = '8'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '45的排列-数字卡片', '45 Layout（Cards）',
       'prek', 'montessori', 'math', 'courseware',
       '十进制系统介绍', 'published', t.id, '{"category": "十进制系统介绍", "categoryEn": "十进制系统介绍 Decimal System Introduction", "itemType": "lesson", "itemIndex": 9, "title": "45的排列-数字卡片", "titleEn": "45 Layout（Cards）", "slide": 277, "age": "4.5+", "aim": "认识1-9000的数字符号，了解每个数位有多少零", "aimEn": "Recognize number symbols from 1 to 9000, and learn the number of zeros in each place value.", "language": "1-9000的名称", "languageEn": "Names of numbers from 1 to 9000"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'math'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '十进制系统介绍'
      AND r.title = '45的排列-数字卡片'
      AND r.description::json->>'itemIndex' = '9'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '45的排列-数量与数字卡片结合', '45 layout(Combination of Quantities & Number Cards)',
       'prek', 'montessori', 'math', 'courseware',
       '十进制系统介绍', 'published', t.id, '{"category": "十进制系统介绍", "categoryEn": "十进制系统介绍 Decimal System Introduction", "itemType": "lesson", "itemIndex": 10, "title": "45的排列-数量与数字卡片结合", "titleEn": "45 layout(Combination of Quantities & Number Cards)", "slide": 279, "age": "4.5+", "aim": "感受数位的变化和数值的变化", "aimEn": "Perceive the changes of place values and numerical values.", "language": "这是……；这读作……（1-9000的名称）", "languageEn": "This is... ; This reads... (Names of numbers from 1 to 9000)"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'math'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '十进制系统介绍'
      AND r.title = '45的排列-数量与数字卡片结合'
      AND r.description::json->>'itemIndex' = '10'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '四位数的组合（数字卡片）', 'Fomation of numbers (Number cards)',
       'prek', 'montessori', 'math', 'courseware',
       '十进制系统介绍', 'published', t.id, '{"category": "十进制系统介绍", "categoryEn": "十进制系统介绍 Decimal System Introduction", "itemType": "lesson", "itemIndex": 11, "title": "四位数的组合（数字卡片）", "titleEn": "Fomation of numbers (Number cards)", "slide": 281, "age": "4.5+", "aim": "学习组合四位数，并学习读数", "aimEn": "Learn to combine four-digit numbers and read them correctly.", "language": "这读作……（6415:这是6000、400、10、5，组合起来读作六千四百一十五）", "languageEn": "This reads... (Example for 6415: These are 6000, 400, 10 and 5. Combined, it reads six thousand four hundred and fifteen.)"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'math'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '十进制系统介绍'
      AND r.title = '四位数的组合（数字卡片）'
      AND r.description::json->>'itemIndex' = '11'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '四位数的组合（数量与数卡）', 'Fomation of numbers (Number cards and Qauantity)',
       'prek', 'montessori', 'math', 'courseware',
       '十进制系统介绍', 'published', t.id, '{"category": "十进制系统介绍", "categoryEn": "十进制系统介绍 Decimal System Introduction", "itemType": "lesson", "itemIndex": 12, "title": "四位数的组合（数量与数卡）", "titleEn": "Fomation of numbers (Number cards and Qauantity)", "slide": 283, "age": "4.5+", "aim": "学习组合数字，读出数字；学会去银行取数量（去取2个5，1个10，4个100，2个1000)", "aimEn": "Learn to combine and read numbers; learn to withdraw corresponding bead quantities from the Bank (take 5 units, 1 ten, 4 hundreds and 2 thousands).", "language": "这读作……（2415：这是2000、400、10、5，组合起来读作两千四百一十五）", "languageEn": "It reads… (Example: 2415: These are 2000, 400, 10 and 5. Combined, it reads two thousand four hundred and fifteen.)"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'math'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '十进制系统介绍'
      AND r.title = '四位数的组合（数量与数卡）'
      AND r.description::json->>'itemIndex' = '12'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '交换游戏', 'Exchange Game',
       'prek', 'montessori', 'math', 'courseware',
       '十进制系统介绍', 'published', t.id, '{"category": "十进制系统介绍", "categoryEn": "十进制系统介绍 Decimal System Introduction", "itemType": "lesson", "itemIndex": 13, "title": "交换游戏", "titleEn": "Exchange Game", "slide": 285, "age": "4.5岁+", "aim": "儿童能够把未知量通过等量交换变成简单的可知量。", "aimEn": "Children convert unknown bead quantities into standard countable amounts through equivalent trading.", "language": "银行、交换", "languageEn": "Bank, Trade / Exchange"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'math'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '十进制系统介绍'
      AND r.title = '交换游戏'
      AND r.description::json->>'itemIndex' = '13'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '四则运算：无进位加法', 'Operation：Static Addition',
       'prek', 'montessori', 'math', 'courseware',
       '十进制系统运算', 'published', t.id, '{"category": "十进制系统运算", "categoryEn": "十进制系统运算 Decimal System Operation", "itemType": "lesson", "itemIndex": 1, "title": "四则运算：无进位加法", "titleEn": "Operation：Static Addition", "slide": 288, "age": "5岁+", "aim": "认识加法的概念和运算方式", "aimEn": "Understand the concept and operation method of addition.", "language": "银行、无进位加法、加号、相加、等于", "languageEn": "Bank, Addition without regrouping, plus sign, add together, equal"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'math'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '十进制系统运算'
      AND r.title = '四则运算：无进位加法'
      AND r.description::json->>'itemIndex' = '1'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '四则运算：进位加法', 'Operation：Dynamic Addition',
       'prek', 'montessori', 'math', 'courseware',
       '十进制系统运算', 'published', t.id, '{"category": "十进制系统运算", "categoryEn": "十进制系统运算 Decimal System Operation", "itemType": "lesson", "itemIndex": 2, "title": "四则运算：进位加法", "titleEn": "Operation：Dynamic Addition", "slide": 290, "age": "5岁+", "aim": "认识进位加法的概念和运算方式，建立进位的概念", "aimEn": "Learn the concept and operation of addition with regrouping, establish the understanding of place-value regrouping.", "language": "进位加法、银行、交换、加号、相加、等于", "languageEn": "Addition with regrouping, Bank, Exchange, Plus sign, Add, Equals."}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'math'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '十进制系统运算'
      AND r.title = '四则运算：进位加法'
      AND r.description::json->>'itemIndex' = '2'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '四则运算：减法（无借位）', 'Operation：Subtraction',
       'prek', 'montessori', 'math', 'courseware',
       '十进制系统运算', 'published', t.id, '{"category": "十进制系统运算", "categoryEn": "十进制系统运算 Decimal System Operation", "itemType": "lesson", "itemIndex": 3, "title": "四则运算：减法（无借位）", "titleEn": "Operation：Subtraction", "slide": 292, "age": "5岁+", "aim": "认识减法的概念和运算方式", "aimEn": "Understand the concept and operational method of subtraction.", "language": "银行、无借位减肥法、减号、拿走、被减数、减数、等于", "languageEn": "Bank, subtraction without borrowing, minus sign, take away, minuend, subtrahend, equals."}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'math'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '十进制系统运算'
      AND r.title = '四则运算：减法（无借位）'
      AND r.description::json->>'itemIndex' = '3'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '蛇形游戏十的组合', 'Snake Game: Combinations of 10',
       'prek', 'montessori', 'math', 'courseware',
       '记忆练习', 'published', t.id, '{"category": "记忆练习", "categoryEn": "Memory Practice", "itemType": "lesson", "itemIndex": 1, "title": "蛇形游戏十的组合", "titleEn": "Snake Game: Combinations of 10", "slide": 295, "age": "5+", "aim": "探究数量10 及10的组合，为加法做准备。", "aimEn": "Explore the number 10 and its combinations, preparing for addition.", "language": "无", "languageEn": "None"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'math'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '记忆练习'
      AND r.title = '蛇形游戏十的组合'
      AND r.description::json->>'itemIndex' = '1'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '加法蛇形游戏', 'Addition Snake Game',
       'prek', 'montessori', 'math', 'courseware',
       '记忆练习', 'published', t.id, '{"category": "记忆练习", "categoryEn": "Memory Practice", "itemType": "lesson", "itemIndex": 2, "title": "加法蛇形游戏", "titleEn": "Addition Snake Game", "slide": 297, "age": "5+", "aim": "让孩子练习记忆最基本的加法组合", "aimEn": "Allow the child to practice memorizing basic addition combinations.", "language": "无", "languageEn": "None"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'math'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '记忆练习'
      AND r.title = '加法蛇形游戏'
      AND r.description::json->>'itemIndex' = '2'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '加法板', 'Addition Strip Board',
       'prek', 'montessori', 'math', 'courseware',
       '记忆练习', 'published', t.id, '{"category": "记忆练习", "categoryEn": "Memory Practice", "itemType": "lesson", "itemIndex": 3, "title": "加法板", "titleEn": "Addition Strip Board", "slide": 299, "age": "5+", "aim": "给儿童所有可能的加法，帮助儿童记忆这些组合。", "aimEn": "Present children with all possible addition combinations to help them memorize these facts.", "language": "无", "languageEn": "None"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'math'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '记忆练习'
      AND r.title = '加法板'
      AND r.description::json->>'itemIndex' = '3'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '减法板', 'Subtraction Strip Board',
       'prek', 'montessori', 'math', 'courseware',
       '记忆练习', 'published', t.id, '{"category": "记忆练习", "categoryEn": "Memory Practice", "itemType": "lesson", "itemIndex": 4, "title": "减法板", "titleEn": "Subtraction Strip Board", "slide": 301, "age": "5+", "aim": "给儿童所有可能的减法，帮助儿童记忆这些组合。、", "aimEn": "Present children with all possible subtraction combinations to help them memorize these facts.", "language": "无", "languageEn": "None"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'math'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '记忆练习'
      AND r.title = '减法板'
      AND r.description::json->>'itemIndex' = '4'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '自然体验/自然角', 'Nature Experience / Nature Corner',
       'prek', 'montessori', 'culture', 'courseware',
       '植物', 'published', t.id, '{"category": "植物", "categoryEn": "Plants", "itemType": "lesson", "itemIndex": 1, "title": "自然体验/自然角", "titleEn": "Nature Experience / Nature Corner", "slide": 309, "age": "3-6y", "aim": "观察植物的特性", "aimEn": "To observe the characteristics of plants.", "language": "是否会移动、是否会成长或变化、是否会繁殖、是否需要食物", "languageEn": "Does it move? Does it grow or change? Does it reproduce? Does it need food?"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'culture'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '植物'
      AND r.title = '自然体验/自然角'
      AND r.description::json->>'itemIndex' = '1'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '有生命与无生命', 'Living and Non-Living',
       'prek', 'montessori', 'culture', 'courseware',
       '植物', 'published', t.id, '{"category": "植物", "categoryEn": "Plants", "itemType": "lesson", "itemIndex": 2, "title": "有生命与无生命", "titleEn": "Living and Non-Living", "slide": 311, "age": "3y", "aim": "发展观察，比较以及分类的概念", "aimEn": "To develop the concepts of observation, comparison, and classification.", "language": "是否会移动、是否会成长或变化、是否会繁殖、是否需要食物、需要喝水", "languageEn": "Does it move? Does it grow or change? Does it reproduce? Does it need food? Does it need water?"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'culture'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '植物'
      AND r.title = '有生命与无生命'
      AND r.description::json->>'itemIndex' = '2'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '植物与动物的分类', 'Classification of Plants and Animals',
       'prek', 'montessori', 'culture', 'courseware',
       '植物', 'published', t.id, '{"category": "植物", "categoryEn": "Plants", "itemType": "lesson", "itemIndex": 3, "title": "植物与动物的分类", "titleEn": "Classification of Plants and Animals", "slide": 313, "age": "3y", "aim": "理解动物是可以移动的，植物不能移动，但它们都属于有生命的", "aimEn": "To understand that animals can move an plants cannot move, and that both are living things.", "language": "动物可以自己移动；植物不会自己移动；动物异养，植物自养", "languageEn": "Animals can move by themselves; plants can not move by themselves; animals are heterotrophic, plants are autotrophic"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'culture'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '植物'
      AND r.title = '植物与动物的分类'
      AND r.description::json->>'itemIndex' = '3'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '认识植物的部分/认识植物', 'Parts of a Plant / Plant Recognition',
       'prek', 'montessori', 'culture', 'courseware',
       '植物', 'published', t.id, '{"category": "植物", "categoryEn": "Plants", "itemType": "lesson", "itemIndex": 4, "title": "认识植物的部分/认识植物", "titleEn": "Parts of a Plant / Plant Recognition", "slide": 315, "age": "3-6y", "aim": "认识一棵完整的植物", "aimEn": "To recognize a complete plant.", "language": "根，茎，叶，花，", "languageEn": "Root, stem, leaf, flower"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'culture'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '植物'
      AND r.title = '认识植物的部分/认识植物'
      AND r.description::json->>'itemIndex' = '4'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '树的嵌板', 'Tree Puzzle Insets',
       'prek', 'montessori', 'culture', 'courseware',
       '植物', 'published', t.id, '{"category": "植物", "categoryEn": "Plants", "itemType": "lesson", "itemIndex": 5, "title": "树的嵌板", "titleEn": "Tree Puzzle Insets", "slide": 317, "age": "3-6y", "aim": "认识树的基本组成部分", "aimEn": "Recognize basic components of a tree", "language": "树根，树干，树枝，树叶，果实", "languageEn": "Tree root, Trunk, Branch, Leaf, Fruit"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'culture'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '植物'
      AND r.title = '树的嵌板'
      AND r.description::json->>'itemIndex' = '5'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '树的三段卡', 'Tree Three-Part Cards',
       'prek', 'montessori', 'culture', 'courseware',
       '植物', 'published', t.id, '{"category": "植物", "categoryEn": "Plants", "itemType": "lesson", "itemIndex": 6, "title": "树的三段卡", "titleEn": "Tree Three-Part Cards", "slide": 319, "age": "3-6y", "aim": "认识树的基本组成部分", "aimEn": "Recognize the basic parts of a tree", "language": "树、树根、树干、树枝、树叶", "languageEn": "Tree, Root, Trunk, Branch, Leaf"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'culture'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '植物'
      AND r.title = '树的三段卡'
      AND r.description::json->>'itemIndex' = '6'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '树的定义小书', 'Definition Book of Trees',
       'prek', 'montessori', 'culture', 'courseware',
       '植物', 'published', t.id, '{"category": "植物", "categoryEn": "Plants", "itemType": "lesson", "itemIndex": 7, "title": "树的定义小书", "titleEn": "Definition Book of Trees", "slide": 321, "age": "3-6y", "aim": "认识树的基本组成部分", "aimEn": "Recognize the basic components of a tree", "language": "这是树、这是树根、这是树干、这是树枝、这是树叶", "languageEn": "This is a tree. This is a root. This is a trunk.This is a branch. This is a leaf."}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'culture'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '植物'
      AND r.title = '树的定义小书'
      AND r.description::json->>'itemIndex' = '7'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '叶的解剖', 'Leaf Dissectoin',
       'prek', 'montessori', 'culture', 'courseware',
       '植物', 'published', t.id, '{"category": "植物", "categoryEn": "Plants", "itemType": "lesson", "itemIndex": 8, "title": "叶的解剖", "titleEn": "Leaf Dissectoin", "slide": 323, "age": "3-6y", "aim": "认识叶的构成", "aimEn": "Recognize the components of a leaf", "language": "叶片，叶脉，叶柄，托叶，叶边，叶尖", "languageEn": "—"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'culture'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '植物'
      AND r.title = '叶的解剖'
      AND r.description::json->>'itemIndex' = '8'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '叶的嵌板', 'Leaf Insets',
       'prek', 'montessori', 'culture', 'courseware',
       '植物', 'published', t.id, '{"category": "植物", "categoryEn": "Plants", "itemType": "lesson", "itemIndex": 9, "title": "叶的嵌板", "titleEn": "Leaf Insets", "slide": 325, "age": "3-6y", "aim": "认识叶的构成", "aimEn": "Purpose: To recognize the components of a leaf", "language": "将嵌板取出、将嵌板放回", "languageEn": "—"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'culture'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '植物'
      AND r.title = '叶的嵌板'
      AND r.description::json->>'itemIndex' = '9'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '叶的三段卡', 'Leaf Three Part Cards',
       'prek', 'montessori', 'culture', 'courseware',
       '植物', 'published', t.id, '{"category": "植物", "categoryEn": "Plants", "itemType": "lesson", "itemIndex": 10, "title": "叶的三段卡", "titleEn": "Leaf Three Part Cards", "slide": 327, "age": "3-6y", "aim": "认识叶的构成", "aimEn": "Recognize the components of a leaf", "language": "这是叶片、这是叶脉、这是叶柄、这是叶尖", "languageEn": "This is the leaf blade. This is the leaf vein. This is the petiole. This is the leaf apex."}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'culture'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '植物'
      AND r.title = '叶的三段卡'
      AND r.description::json->>'itemIndex' = '10'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '叶的定义小书', 'Definition Booklet of Leaves Error Control:',
       'prek', 'montessori', 'culture', 'courseware',
       '植物', 'published', t.id, '{"category": "植物", "categoryEn": "Plants", "itemType": "lesson", "itemIndex": 11, "title": "叶的定义小书", "titleEn": "Definition Booklet of Leaves Error Control:", "slide": 329, "age": "3-6y", "aim": "认识叶的构成", "aimEn": "Purpose: Recognize the components of a leaf", "language": "这是叶片、这是叶脉、这是叶柄、这是叶尖", "languageEn": "This is the leaf blade.This is the leaf vein. This is the leaf petiole.This is the leaf apex."}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'culture'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '植物'
      AND r.title = '叶的定义小书'
      AND r.description::json->>'itemIndex' = '11'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '叶形橱', 'Leaf Shape Cabinet',
       'prek', 'montessori', 'culture', 'courseware',
       '植物', 'published', t.id, '{"category": "植物", "categoryEn": "Plants", "itemType": "lesson", "itemIndex": 12, "title": "叶形橱", "titleEn": "Leaf Shape Cabinet", "slide": 331, "age": "3-6y", "aim": "学习叶的形状", "aimEn": "Learn different shapes of leaves", "language": "这是叶形框架，空心的，是叶子的轮廓；这是叶形嵌板;是叶子的实体", "languageEn": "This is the leaf shape frame. It is hollow, showing the outline of leaf.This is theleaf shape inset, representing the solid form of a leaf."}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'culture'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '植物'
      AND r.title = '叶形橱'
      AND r.description::json->>'itemIndex' = '12'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '花的解剖', 'Flower Dissection',
       'prek', 'montessori', 'culture', 'courseware',
       '植物', 'published', t.id, '{"category": "植物", "categoryEn": "Plants", "itemType": "lesson", "itemIndex": 13, "title": "花的解剖", "titleEn": "Flower Dissection", "slide": 333, "age": "3-6y", "aim": "认识花的构成部分", "aimEn": "To recognize the components of a flower", "language": "这是一朵完整的康乃馨；我们来找一找,说一说花的各部位名称", "languageEn": "This is a whole carnation.Let’s find out and name each part of the flower."}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'culture'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '植物'
      AND r.title = '花的解剖'
      AND r.description::json->>'itemIndex' = '13'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '花的嵌板', 'Flower Insets',
       'prek', 'montessori', 'culture', 'courseware',
       '植物', 'published', t.id, '{"category": "植物", "categoryEn": "Plants", "itemType": "lesson", "itemIndex": 14, "title": "花的嵌板", "titleEn": "Flower Insets", "slide": 335, "age": "3-6y", "aim": "认识花的构成部分", "aimEn": "Recognize different parts of a flower", "language": "花的嵌板、花的框架", "languageEn": "Flower inset ;Flower frame"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'culture'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '植物'
      AND r.title = '花的嵌板'
      AND r.description::json->>'itemIndex' = '14'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '花的三段卡', 'Flower Three-Part Cards',
       'prek', 'montessori', 'culture', 'courseware',
       '植物', 'published', t.id, '{"category": "植物", "categoryEn": "Plants", "itemType": "lesson", "itemIndex": 15, "title": "花的三段卡", "titleEn": "Flower Three-Part Cards", "slide": 337, "age": "3-6y", "aim": "认识花的构成部分", "aimEn": "Recognize the components of a flower", "language": "这是花；这是花冠；这是萼片；这是花瓣；这是雄蕊；这是雌蕊；", "languageEn": "This is a flower.This is a corolla.This is a sepal. This is a petal.This is a stamen.This is a pistil."}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'culture'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '植物'
      AND r.title = '花的三段卡'
      AND r.description::json->>'itemIndex' = '15'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '花的定义小书', 'Flower Definition Book',
       'prek', 'montessori', 'culture', 'courseware',
       '植物', 'published', t.id, '{"category": "植物", "categoryEn": "Plants", "itemType": "lesson", "itemIndex": 16, "title": "花的定义小书", "titleEn": "Flower Definition Book", "slide": 339, "age": "3-6y", "aim": "认识花的构成部分", "aimEn": "Recognize the components of a flower", "language": "花包含四个部分；介绍各部位名称以及功能", "languageEn": "A flower consists of four parts; introduce the name and function of each part"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'culture'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '植物'
      AND r.title = '花的定义小书'
      AND r.description::json->>'itemIndex' = '16'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '植物的生长过程', 'Plant Growth Cycle',
       'prek', 'montessori', 'culture', 'courseware',
       '植物', 'published', t.id, '{"category": "植物", "categoryEn": "Plants", "itemType": "lesson", "itemIndex": 17, "title": "植物的生长过程", "titleEn": "Plant Growth Cycle", "slide": 341, "age": "3-6岁", "aim": "认识植物完整的生长过程，了解植物生长的不同阶段", "aimEn": "Recognize the complete growth process and different growth stages of plants", "language": "植物有完整的生长周期；介绍植物各生长阶段名称及生长特点", "languageEn": "Plants have a complete growth cycle; introduce the names and characteristics of each growth stage"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'culture'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '植物'
      AND r.title = '植物的生长过程'
      AND r.description::json->>'itemIndex' = '17'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '植物的生长周期', 'Plant Growth Cycle',
       'prek', 'montessori', 'culture', 'courseware',
       '植物', 'published', t.id, '{"category": "植物", "categoryEn": "Plants", "itemType": "lesson", "itemIndex": 18, "title": "植物的生长周期", "titleEn": "Plant Growth Cycle", "slide": 343, "age": "3-6岁", "aim": "学习特定植物的生长周期", "aimEn": "To learn the growth cycle of specific plants", "language": "植物有完整的生长周期；能够准确说出植物各生", "languageEn": "Plants have a complete growth cycle. Children can name each growth stage accurately and learn the characteristics of each stage"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'culture'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '植物'
      AND r.title = '植物的生长周期'
      AND r.description::json->>'itemIndex' = '18'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '我们吃的是植物的什么', 'Which Parts of Plants Do We Eat',
       'prek', 'montessori', 'culture', 'courseware',
       '植物', 'published', t.id, '{"category": "植物", "categoryEn": "Plants", "itemType": "lesson", "itemIndex": 19, "title": "我们吃的是植物的什么", "titleEn": "Which Parts of Plants Do We Eat", "slide": 345, "age": "3-6岁", "aim": "认识植物六大可食用部位（根、茎、叶、花、果实、", "aimEn": "Learn the six edible parts of plants (roots, stems, leaves, flowers, fruits, seeds), and distinguish the edible parts of common fruits and vegetables.", "language": "一株植物有不同的部位；不同的植物，我们吃", "languageEn": "A plant has different parts. We eat different parts of different plants. Children can name edible plant parts accurately and learn their features"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'culture'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '植物'
      AND r.title = '我们吃的是植物的什么'
      AND r.description::json->>'itemIndex' = '19'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '观察动物', 'Animal Observation',
       'prek', 'montessori', 'culture', 'courseware',
       '动物', 'published', t.id, '{"category": "动物", "categoryEn": "Animals", "itemType": "lesson", "itemIndex": 1, "title": "观察动物", "titleEn": "Animal Observation", "slide": 348, "age": "3y", "aim": "建立幼儿对常见动物的基础认知", "aimEn": "To help children build basic cognition of common animals", "language": "无", "languageEn": "None"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'culture'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '动物'
      AND r.title = '观察动物'
      AND r.description::json->>'itemIndex' = '1'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '有生命无生命', 'Living&Non-Living',
       'prek', 'montessori', 'culture', 'courseware',
       '动物', 'published', t.id, '{"category": "动物", "categoryEn": "Animals", "itemType": "lesson", "itemIndex": 2, "title": "有生命无生命", "titleEn": "Living&Non-Living", "slide": 350, "age": "3y", "aim": "建立孩子对有生命和无生命的物种和物品的感恩和认知", "aimEn": "To build awareness and gratitude for living and non-living things.", "language": "是否会移动、是否会成长或变化、是否会繁殖、是否需要食物", "languageEn": "Does it move? Does it grow or change? Does it reproduce? Does it need food?"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'culture'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '动物'
      AND r.title = '有生命无生命'
      AND r.description::json->>'itemIndex' = '2'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '动物植物分类', 'Animal & Plant Classification',
       'prek', 'montessori', 'culture', 'courseware',
       '动物', 'published', t.id, '{"category": "动物", "categoryEn": "Animals", "itemType": "lesson", "itemIndex": 3, "title": "动物植物分类", "titleEn": "Animal & Plant Classification", "slide": 352, "age": "3y", "aim": "建立孩子对植物和动物的感恩和认知", "aimEn": "To build awareness and gratitude for animals and plants.", "language": "是否能自己移动？是否会自己发出声音？是否吃食物？是否需要自己找食物？", "languageEn": "Can it move by itself? Does it make sounds? Does it eat food? Does it need to find its own food?"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'culture'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '动物'
      AND r.title = '动物植物分类'
      AND r.description::json->>'itemIndex' = '3'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '有脊椎无脊椎分类', 'Vertebrate / Invertebrate Classification',
       'prek', 'montessori', 'culture', 'courseware',
       '动物', 'published', t.id, '{"category": "动物", "categoryEn": "Animals", "itemType": "lesson", "itemIndex": 4, "title": "有脊椎无脊椎分类", "titleEn": "Vertebrate / Invertebrate Classification", "slide": 354, "age": "3+", "aim": "让幼儿学会区分有脊椎动物和无脊椎动物，并能举出常见代表物（如哺乳类、鸟类、昆虫等）。", "aimEn": "To distinguish vertebrates from invertebrates and name common examples (mammals, birds, insects, etc.).", "language": "有脊椎动物：身体内部有一条由许多脊椎骨组成的脊柱，它可以支撑身体；运动方式更加多样，如爬、飞、跳、游、走、跑；无脊椎动物：没有脊柱，身体大多很柔软；运动的…", "languageEn": "Vertebrates have a backbone/spine; move in many ways (crawl, fly, jump, swim, walk, run). Invertebrates have no backbone; bodies are mostly soft; move by muscle power."}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'culture'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '动物'
      AND r.title = '有脊椎无脊椎分类'
      AND r.description::json->>'itemIndex' = '4'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '有脊椎五大类', 'Five Classes of Vertebrates',
       'prek', 'montessori', 'culture', 'courseware',
       '动物', 'published', t.id, '{"category": "动物", "categoryEn": "Animals", "itemType": "lesson", "itemIndex": 5, "title": "有脊椎五大类", "titleEn": "Five Classes of Vertebrates", "slide": 356, "age": "3-6", "aim": "帮助孩子识别并区分脊椎动物的五大类别（鱼类、两栖类、爬行类、鸟类、哺乳类）", "aimEn": "To identify and distinguish the five classes of vertebrates.", "language": "哺乳动物、爬行动物、鸟类、鱼类、两栖动物", "languageEn": "mammals, reptiles, birds, fish, amphibians"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'culture'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '动物'
      AND r.title = '有脊椎五大类'
      AND r.description::json->>'itemIndex' = '5'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '哺乳动物', 'Mammals',
       'prek', 'montessori', 'culture', 'courseware',
       '动物', 'published', t.id, '{"category": "动物", "categoryEn": "Animals", "itemType": "lesson", "itemIndex": 6, "title": "哺乳动物", "titleEn": "Mammals", "slide": 358, "age": "3-6", "aim": "认识哺乳动物的核心特征——胎生且幼崽需喝母乳长大", "aimEn": "To know mammals are born live and drink milk.", "language": "需要喝母乳、生出来就是宝宝", "languageEn": "Drink mother''s milk; born as babies"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'culture'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '动物'
      AND r.title = '哺乳动物'
      AND r.description::json->>'itemIndex' = '6'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '马的嵌板', 'Horse Puzzle',
       'prek', 'montessori', 'culture', 'courseware',
       '动物', 'published', t.id, '{"category": "动物", "categoryEn": "Animals", "itemType": "lesson", "itemIndex": 7, "title": "马的嵌板", "titleEn": "Horse Puzzle", "slide": 360, "age": "3-6", "aim": "认识马的身体各部位名称及位置关系", "aimEn": "To learn the names and positions of horse body parts.", "language": "马，头、耳、鬃毛、前腿、后腿、身体、脖子、蹄、尾巴", "languageEn": "horse, head, ear, mane, front legs, hind legs, body, neck, hoof, tail"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'culture'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '动物'
      AND r.title = '马的嵌板'
      AND r.description::json->>'itemIndex' = '7'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '马的三段卡', 'Horse 3-Part Cards',
       'prek', 'montessori', 'culture', 'courseware',
       '动物', 'published', t.id, '{"category": "动物", "categoryEn": "Animals", "itemType": "lesson", "itemIndex": 8, "title": "马的三段卡", "titleEn": "Horse 3-Part Cards", "slide": 362, "age": "3-6", "aim": "通过配对与命名，巩固对马身体各部位的认知", "aimEn": "To reinforce knowledge of horse body parts through matching and naming.", "language": "马，头、耳、鬃毛、前腿、后腿、身体、脖子、蹄、尾巴", "languageEn": "horse, head, ear, mane, front legs, hind legs, body, neck, hoof, tail"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'culture'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '动物'
      AND r.title = '马的三段卡'
      AND r.description::json->>'itemIndex' = '8'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '马的定义小书', 'Horse Definition Booklet',
       'prek', 'montessori', 'culture', 'courseware',
       '动物', 'published', t.id, '{"category": "动物", "categoryEn": "Animals", "itemType": "lesson", "itemIndex": 9, "title": "马的定义小书", "titleEn": "Horse Definition Booklet", "slide": 364, "age": "3-6", "aim": "了解马各部位的功能与作用，建立“部位-功能”的关联认知", "aimEn": "To learn the function of each horse body part and establish \"part–function\" connections.", "language": "头（用来吃东西）、耳（用来听声音）、鬃毛（保护颈部）、前腿（支撑身体）、后腿（跳跃与奔跑）、身体（容纳内脏）、脖子（连接头与身体）、蹄（保护脚趾）、尾巴（…", "languageEn": "head (for eating), ears (for hearing), mane (protects the neck), front legs (support the body), hind legs (jumping and running), body (holds internal organs), neck (connects head to body), hoof (protects the toes), tail (swats away insects)"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'culture'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '动物'
      AND r.title = '马的定义小书'
      AND r.description::json->>'itemIndex' = '9'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '鸟类模型', 'Bird Models',
       'prek', 'montessori', 'culture', 'courseware',
       '动物', 'published', t.id, '{"category": "动物", "categoryEn": "Animals", "itemType": "lesson", "itemIndex": 10, "title": "鸟类模型", "titleEn": "Bird Models", "slide": 366, "age": "3+", "aim": "通过观察与操作，掌握鸟类的核心特征（有脊柱、羽毛、硬壳蛋、温血、用肺呼吸、飞翔移动、照顾幼子）", "aimEn": "To learn the core features of birds through observation and handling (spine, feathers, hard-shelled eggs, warm-blooded, lung breathing, flying, caring for young).", "language": "有脊柱、大部分时间在空中、用肺呼吸、有羽毛覆盖、产硬壳蛋、照顾幼子、温血动物、靠飞翔移动", "languageEn": ") Control of Error: The materials themselves Key Language: has a spine, mostly lives in the air, breathes with lungs, covered in feathers, lays hard-shelled eggs, cares for its young, warm-blooded, moves by flying"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'culture'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '动物'
      AND r.title = '鸟类模型'
      AND r.description::json->>'itemIndex' = '10'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '鸟的嵌板', 'Bird Puzzle',
       'prek', 'montessori', 'culture', 'courseware',
       '动物', 'published', t.id, '{"category": "动物", "categoryEn": "Animals", "itemType": "lesson", "itemIndex": 11, "title": "鸟的嵌板", "titleEn": "Bird Puzzle", "slide": 368, "age": "待标注", "aim": "认识鸟的身体各部位名称及位置关系。", "aimEn": "To learn the names and positions of bird body parts.", "language": "鸟、头、胸、翅膀、喙、尾巴、爪、腿", "languageEn": "bird, head, chest, wing, beak, tail, claw, leg"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'culture'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '动物'
      AND r.title = '鸟的嵌板'
      AND r.description::json->>'itemIndex' = '11'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '鸟的三段卡', 'Bird 3-Part Cards',
       'prek', 'montessori', 'culture', 'courseware',
       '动物', 'published', t.id, '{"category": "动物", "categoryEn": "Animals", "itemType": "lesson", "itemIndex": 12, "title": "鸟的三段卡", "titleEn": "Bird 3-Part Cards", "slide": 370, "age": "待标注", "aim": "通过配对与命名，巩固对鸟身体各部位的认知", "aimEn": "To reinforce knowledge of bird body parts through matching and naming.", "language": "鸟、头、胸、翅膀、喙、尾巴、爪、腿", "languageEn": "bird, head, chest, wing, beak, tail, claw, leg"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'culture'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '动物'
      AND r.title = '鸟的三段卡'
      AND r.description::json->>'itemIndex' = '12'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '鸟的定义小书', 'Bird Definition Booklet',
       'prek', 'montessori', 'culture', 'courseware',
       '动物', 'published', t.id, '{"category": "动物", "categoryEn": "Animals", "itemType": "lesson", "itemIndex": 13, "title": "鸟的定义小书", "titleEn": "Bird Definition Booklet", "slide": 372, "age": "待标注", "aim": "了解鸟各部位的功能", "aimEn": "To learn the functions of bird body parts.", "language": "鸟、头、胸、翅膀、喙、尾巴、爪、腿", "languageEn": "bird, head, chest, wing, beak, tail, claw, leg"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'culture'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '动物'
      AND r.title = '鸟的定义小书'
      AND r.description::json->>'itemIndex' = '13'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '鱼类模型', 'Fish Models',
       'prek', 'montessori', 'culture', 'courseware',
       '动物', 'published', t.id, '{"category": "动物", "categoryEn": "Animals", "itemType": "lesson", "itemIndex": 14, "title": "鱼类模型", "titleEn": "Fish Models", "slide": 374, "age": "3+", "aim": "掌握鱼类的核心特征", "aimEn": "To learn the core features of fish.", "language": "有脊柱、水生、鳃呼吸、有鳞、胶状蛋、冷血、不照顾幼子、靠游移动", "languageEn": "has a spine, lives in water, breathes with gills, has scales, lays jelly-like eggs, cold-blooded, does not care for young, moves by swimming"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'culture'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '动物'
      AND r.title = '鱼类模型'
      AND r.description::json->>'itemIndex' = '14'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '鱼的嵌板', 'Fish Puzzle',
       'prek', 'montessori', 'culture', 'courseware',
       '动物', 'published', t.id, '{"category": "动物", "categoryEn": "Animals", "itemType": "lesson", "itemIndex": 15, "title": "鱼的嵌板", "titleEn": "Fish Puzzle", "slide": 376, "age": "3+", "aim": "认识鱼的身体部位及位置", "aimEn": "To learn the names and positions of fish body parts.", "language": "鱼、头、腹翅、胸鳍、背鳍、尾鳍、腹鳍、臀鳍、侧线", "languageEn": "fish, head, ventral fin, pectoral fin, dorsal fin, tail fin, pelvic fin, anal fin, lateral line"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'culture'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '动物'
      AND r.title = '鱼的嵌板'
      AND r.description::json->>'itemIndex' = '15'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '鱼的三段卡', 'Fish 3-Part Cards',
       'prek', 'montessori', 'culture', 'courseware',
       '动物', 'published', t.id, '{"category": "动物", "categoryEn": "Animals", "itemType": "lesson", "itemIndex": 16, "title": "鱼的三段卡", "titleEn": "Fish 3-Part Cards", "slide": 378, "age": "3+", "aim": "巩固鱼身体部位的认知", "aimEn": "To reinforce knowledge of fish body parts.", "language": "鱼、头、腹翅、胸鳍、背鳍、尾鳍、腹鳍、臀鳍、侧线", "languageEn": "fish, head, ventral fin, pectoral fin, dorsal fin, tail fin, pelvic fin, anal fin, lateral line"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'culture'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '动物'
      AND r.title = '鱼的三段卡'
      AND r.description::json->>'itemIndex' = '16'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '鱼的定义小书', 'Fish Definition Booklet',
       'prek', 'montessori', 'culture', 'courseware',
       '动物', 'published', t.id, '{"category": "动物", "categoryEn": "Animals", "itemType": "lesson", "itemIndex": 17, "title": "鱼的定义小书", "titleEn": "Fish Definition Booklet", "slide": 380, "age": "3+", "aim": "了解鱼各部位的功能", "aimEn": "To learn the functions of fish body parts.", "language": "鱼、头、腹翅、胸鳍、背鳍、尾鳍、腹鳍、臀鳍、侧线", "languageEn": "fish, head, ventral fin, pectoral fin, dorsal fin, tail fin, pelvic fin, anal fin, lateral line"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'culture'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '动物'
      AND r.title = '鱼的定义小书'
      AND r.description::json->>'itemIndex' = '17'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '两栖动物模型', 'Amphibian Models',
       'prek', 'montessori', 'culture', 'courseware',
       '动物', 'published', t.id, '{"category": "动物", "categoryEn": "Animals", "itemType": "lesson", "itemIndex": 18, "title": "两栖动物模型", "titleEn": "Amphibian Models", "slide": 382, "age": "3+", "aim": "掌握两栖动物的核心特征与变态过程", "aimEn": "To learn the core features and metamorphosis of amphibians.", "language": "有脊柱、先生活在水里然后生活在陆地上、先用鳃呼吸然后用肺呼吸、通常有光滑湿润的皮肤、产大量的无壳蛋、不照顾幼子、冷血动物、通常是身体贴近地面靠四肢爬行、两…", "languageEn": "has a spine, lives in water first then on land, breathes with gills then lungs, smooth moist skin, lays many shell-less eggs, does not care for young, cold-blooded, crawls close to the ground, undergoes metamorphosis"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'culture'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '动物'
      AND r.title = '两栖动物模型'
      AND r.description::json->>'itemIndex' = '18'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '青蛙的嵌板', 'Frog Puzzle',
       'prek', 'montessori', 'culture', 'courseware',
       '动物', 'published', t.id, '{"category": "动物", "categoryEn": "Animals", "itemType": "lesson", "itemIndex": 19, "title": "青蛙的嵌板", "titleEn": "Frog Puzzle", "slide": 384, "age": "3+", "aim": "认识青蛙的身体部位及位置", "aimEn": "To learn the names and positions of frog body parts.", "language": "青蛙、头、眼睛、身体、蹼足、前腿、后腿", "languageEn": "frog, head, eye, body, webbed foot, front leg, hind leg"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'culture'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '动物'
      AND r.title = '青蛙的嵌板'
      AND r.description::json->>'itemIndex' = '19'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '青蛙的三段卡', 'Frog 3-Part Cards',
       'prek', 'montessori', 'culture', 'courseware',
       '动物', 'published', t.id, '{"category": "动物", "categoryEn": "Animals", "itemType": "lesson", "itemIndex": 20, "title": "青蛙的三段卡", "titleEn": "Frog 3-Part Cards", "slide": 386, "age": "3+", "aim": "巩固青蛙身体部位的认知", "aimEn": "To reinforce knowledge of frog body parts.", "language": "青蛙、头、眼睛、身体、蹼足、前腿、后腿", "languageEn": "frog, head, eye, body, webbed foot, front leg, hind leg"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'culture'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '动物'
      AND r.title = '青蛙的三段卡'
      AND r.description::json->>'itemIndex' = '20'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '青蛙的定义小书', 'Frog Definition Booklet',
       'prek', 'montessori', 'culture', 'courseware',
       '动物', 'published', t.id, '{"category": "动物", "categoryEn": "Animals", "itemType": "lesson", "itemIndex": 21, "title": "青蛙的定义小书", "titleEn": "Frog Definition Booklet", "slide": 388, "age": "3+", "aim": "了解青蛙各部位的功能", "aimEn": "To learn the functions of frog body parts.", "language": "青蛙、头、眼睛、身体、蹼足、前腿、后腿", "languageEn": "frog, head, eye, body, webbed foot, front leg, hind leg"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'culture'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '动物'
      AND r.title = '青蛙的定义小书'
      AND r.description::json->>'itemIndex' = '21'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '爬行动物模型', 'Reptile Models',
       'prek', 'montessori', 'culture', 'courseware',
       '动物', 'published', t.id, '{"category": "动物", "categoryEn": "Animals", "itemType": "lesson", "itemIndex": 22, "title": "爬行动物模型", "titleEn": "Reptile Models", "slide": 390, "age": "3+", "aim": "待补充", "aimEn": "To learn the core features of reptiles.", "language": "有脊柱、生活在陆地上、用肺呼吸、皮肤干燥有鳞、硬壳蛋、有些爬行动物照顾幼子，有些不照顾、冷血动物、身体贴近地面爬行", "languageEn": "has a spine, lives on land, breathes with lungs, dry scaly skin, lays hard-shelled eggs, some care for young (some do not), cold-blooded, crawls close to the ground"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'culture'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '动物'
      AND r.title = '爬行动物模型'
      AND r.description::json->>'itemIndex' = '22'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '龟的嵌板', 'Turtle Puzzle',
       'prek', 'montessori', 'culture', 'courseware',
       '动物', 'published', t.id, '{"category": "动物", "categoryEn": "Animals", "itemType": "lesson", "itemIndex": 23, "title": "龟的嵌板", "titleEn": "Turtle Puzzle", "slide": 392, "age": "3+", "aim": "认识乌龟的身体部位及位置", "aimEn": "To learn the names and positions of turtle body parts.", "language": "乌龟、头、颈部、龟壳、腿、尾巴、爪、腹甲", "languageEn": "turtle, head, neck, shell, leg, tail, claw, plastron"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'culture'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '动物'
      AND r.title = '龟的嵌板'
      AND r.description::json->>'itemIndex' = '23'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '龟的三段卡', 'Turtle 3-Part Cards',
       'prek', 'montessori', 'culture', 'courseware',
       '动物', 'published', t.id, '{"category": "动物", "categoryEn": "Animals", "itemType": "lesson", "itemIndex": 24, "title": "龟的三段卡", "titleEn": "Turtle 3-Part Cards", "slide": 394, "age": "3+", "aim": "巩固乌龟身体部位的认知", "aimEn": "To reinforce knowledge of turtle body parts.", "language": "乌龟、头、颈部、龟壳、腿、尾巴、爪、腹甲", "languageEn": "turtle, head, neck, shell, leg, tail, claw, plastron"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'culture'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '动物'
      AND r.title = '龟的三段卡'
      AND r.description::json->>'itemIndex' = '24'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '龟的定义小书', 'Turtle Definition Booklet',
       'prek', 'montessori', 'culture', 'courseware',
       '动物', 'published', t.id, '{"category": "动物", "categoryEn": "Animals", "itemType": "lesson", "itemIndex": 25, "title": "龟的定义小书", "titleEn": "Turtle Definition Booklet", "slide": 396, "age": "3+", "aim": "了解乌龟各部位的功能", "aimEn": "To learn the functions of turtle body parts.", "language": "乌龟、头、颈部、龟壳、腿、尾巴、爪、腹甲", "languageEn": "turtle, head, neck, shell, leg, tail, claw, plastron"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'culture'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '动物'
      AND r.title = '龟的定义小书'
      AND r.description::json->>'itemIndex' = '25'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '鸡（鸟类）生长周期', 'Chicken (Bird) Life Cycle',
       'prek', 'montessori', 'culture', 'courseware',
       '动物', 'published', t.id, '{"category": "动物", "categoryEn": "Animals", "itemType": "lesson", "itemIndex": 26, "title": "鸡（鸟类）生长周期", "titleEn": "Chicken (Bird) Life Cycle", "slide": 398, "age": "待标注", "aim": "了解鸡的生长变化过程", "aimEn": "To learn the growth and change process of a chicken.", "language": "蛋→雏鸟→幼鸟→成年鸟", "languageEn": "egg → hatchling → chick → adult"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'culture'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '动物'
      AND r.title = '鸡（鸟类）生长周期'
      AND r.description::json->>'itemIndex' = '26'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '青蛙生长周期', 'Frog Life Cycle',
       'prek', 'montessori', 'culture', 'courseware',
       '动物', 'published', t.id, '{"category": "动物", "categoryEn": "Animals", "itemType": "lesson", "itemIndex": 27, "title": "青蛙生长周期", "titleEn": "Frog Life Cycle", "slide": 400, "age": "3+", "aim": "了解青蛙的变态发育过程", "aimEn": "To learn the metamorphosis process of a frog.", "language": "卵→蝌蚪→变态期→幼蛙→成年蛙", "languageEn": "egg → tadpole → metamorphosis → froglet → adult frog"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'culture'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '动物'
      AND r.title = '青蛙生长周期'
      AND r.description::json->>'itemIndex' = '27'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '自选哺乳动物（牛）', 'Free Choice Mammal (Cow)',
       'prek', 'montessori', 'culture', 'courseware',
       '动物', 'published', t.id, '{"category": "动物", "categoryEn": "Animals", "itemType": "lesson", "itemIndex": 28, "title": "自选哺乳动物（牛）", "titleEn": "Free Choice Mammal (Cow)", "slide": 402, "age": "3+", "aim": "了解牛的发育过程", "aimEn": "Learn about the growth process of cows", "language": "胚胎期、犊牛期、育成期、成年期", "languageEn": "embryonic stage, calf stage, growing stage, adult stage"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'culture'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '动物'
      AND r.title = '自选哺乳动物（牛）'
      AND r.description::json->>'itemIndex' = '28'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '三文鱼（鱼）生长周期', 'Salmon (Fish) Life Cycle',
       'prek', 'montessori', 'culture', 'courseware',
       '动物', 'published', t.id, '{"category": "动物", "categoryEn": "Animals", "itemType": "lesson", "itemIndex": 29, "title": "三文鱼（鱼）生长周期", "titleEn": "Salmon (Fish) Life Cycle", "slide": 404, "age": "3+", "aim": "了解三文鱼生长变化过程", "aimEn": "To learn the growth process of a salmon.", "language": "卵、孵化、幼年期、小三文鱼、三文鱼", "languageEn": "egg, hatchling, fry, parr, adult salmon"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'culture'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '动物'
      AND r.title = '三文鱼（鱼）生长周期'
      AND r.description::json->>'itemIndex' = '29'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '龟生长周期', 'Turtle Life Cycle',
       'prek', 'montessori', 'culture', 'courseware',
       '动物', 'published', t.id, '{"category": "动物", "categoryEn": "Animals", "itemType": "lesson", "itemIndex": 30, "title": "龟生长周期", "titleEn": "Turtle Life Cycle", "slide": 406, "age": "3+", "aim": "了解龟的生长变化过程", "aimEn": "To learn the growth process of a turtle.", "language": "卵→孵化→幼龟→成年龟", "languageEn": "egg → hatching → hatchling → adult turtle"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'culture'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '动物'
      AND r.title = '龟生长周期'
      AND r.description::json->>'itemIndex' = '30'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '蝴蝶的嵌板', 'Butterfly Puzzle',
       'prek', 'montessori', 'culture', 'courseware',
       '动物', 'published', t.id, '{"category": "动物", "categoryEn": "Animals", "itemType": "lesson", "itemIndex": 31, "title": "蝴蝶的嵌板", "titleEn": "Butterfly Puzzle", "slide": 408, "age": "3+", "aim": "认识蝴蝶的身体部位及位置", "aimEn": "To learn the names and positions of butterfly body parts.", "language": "蝴蝶、头、触角、复眼、口器、翅膀、胸部、腹部、足", "languageEn": "butterfly, head, antennae, compound eyes, mouthparts, wings, thorax, abdomen, legs"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'culture'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '动物'
      AND r.title = '蝴蝶的嵌板'
      AND r.description::json->>'itemIndex' = '31'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '蝴蝶的三段卡', 'Butterfly 3-Part Cards',
       'prek', 'montessori', 'culture', 'courseware',
       '动物', 'published', t.id, '{"category": "动物", "categoryEn": "Animals", "itemType": "lesson", "itemIndex": 32, "title": "蝴蝶的三段卡", "titleEn": "Butterfly 3-Part Cards", "slide": 410, "age": "3+", "aim": "巩固蝴蝶身体部位的认知", "aimEn": "To reinforce knowledge of butterfly body parts.", "language": "蝴蝶、头、触角、复眼、口器、翅膀、胸部、腹部、足", "languageEn": "butterfly, head, antennae, compound eyes, mouthparts, wings, thorax, abdomen, legs"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'culture'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '动物'
      AND r.title = '蝴蝶的三段卡'
      AND r.description::json->>'itemIndex' = '32'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '蝴蝶的定义小书', 'Butterfly Definition Booklet',
       'prek', 'montessori', 'culture', 'courseware',
       '动物', 'published', t.id, '{"category": "动物", "categoryEn": "Animals", "itemType": "lesson", "itemIndex": 33, "title": "蝴蝶的定义小书", "titleEn": "Butterfly Definition Booklet", "slide": 412, "age": "3+", "aim": "了解蝴蝶各部位的功能", "aimEn": "To learn the functions of butterfly body parts.", "language": "蝴蝶、头、触角、复眼、口器、翅膀、胸部、腹部、足", "languageEn": "butterfly, head, antennae, compound eyes, mouthparts, wings, thorax, abdomen, legs"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'culture'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '动物'
      AND r.title = '蝴蝶的定义小书'
      AND r.description::json->>'itemIndex' = '33'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '蝴蝶生长周期', 'Butterfly Life Cycle',
       'prek', 'montessori', 'culture', 'courseware',
       '动物', 'published', t.id, '{"category": "动物", "categoryEn": "Animals", "itemType": "lesson", "itemIndex": 34, "title": "蝴蝶生长周期", "titleEn": "Butterfly Life Cycle", "slide": 414, "age": "3+", "aim": "了解蝴蝶的生长变化过程", "aimEn": "To learn the growth process of a butterfly.", "language": "卵-幼虫-蛹-成虫", "languageEn": "egg → caterpillar → chrysalis → adult butterfly"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'culture'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '动物'
      AND r.title = '蝴蝶生长周期'
      AND r.description::json->>'itemIndex' = '34'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '砂纸地球仪', 'Sandpaper Globe',
       'prek', 'montessori', 'culture', 'courseware',
       '地理', 'published', t.id, '{"category": "地理", "categoryEn": "Geography", "itemType": "lesson", "itemIndex": 1, "title": "砂纸地球仪", "titleEn": "Sandpaper Globe", "slide": 417, "age": "3-6岁", "aim": "给出一个地球是球体的印象,识别形成地球的基本要素:土壤和水。", "aimEn": "To give the child an impression that the Earth is a sphere and to identify the basic elements that make up the Earth: soil and water.", "language": "这是水、这是土壤、空气在地球周围", "languageEn": "This is water. This is soil. Air surrounds the Earth."}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'culture'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '地理'
      AND r.title = '砂纸地球仪'
      AND r.description::json->>'itemIndex' = '1'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '土壤空气和水', 'Land, Air and Water',
       'prek', 'montessori', 'culture', 'courseware',
       '地理', 'published', t.id, '{"category": "地理", "categoryEn": "Geography", "itemType": "lesson", "itemIndex": 2, "title": "土壤空气和水", "titleEn": "Land, Air and Water", "slide": 419, "age": "3-6岁", "aim": "帮助孩子理解地球的基本元素。", "aimEn": "To help children understand the basic elements of the Earth.", "language": "“地球是由土壤,空气和水组成的。土壤是我们站在上面的大地操场是土壤。街道建在土壤上。水在河中,海中,雨中和所有我们喝的水中。空气在我们的周围。”", "languageEn": "\"The Earth is made up of soil, air and water. Soil is the ground we stand on. The playground is soil. Streets are built on soil. Water is in rivers, seas, rain and all the water we drink. Air is all around us.\""}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'culture'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '地理'
      AND r.title = '土壤空气和水'
      AND r.description::json->>'itemIndex' = '2'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '彩色地球仪', 'Colored Globe',
       'prek', 'montessori', 'culture', 'courseware',
       '地理', 'published', t.id, '{"category": "地理", "categoryEn": "Geography", "itemType": "lesson", "itemIndex": 3, "title": "彩色地球仪", "titleEn": "Colored Globe", "slide": 421, "age": "3-6岁", "aim": "给孩子大洲的形状的印象。", "aimEn": "To give the child an impression of the shapes of the continents.", "language": "“每一个颜色代表地球上一个不同部分的土地，我们称这些部分为大洲。”", "languageEn": "\"Each color represents a different area of land on the Earth. We call these land areas continents.\""}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'culture'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '地理'
      AND r.title = '彩色地球仪'
      AND r.description::json->>'itemIndex' = '3'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '世界地图拼图的介绍', 'Introduction to the World Map',
       'prek', 'montessori', 'culture', 'courseware',
       '地理', 'published', t.id, '{"category": "地理", "categoryEn": "Geography", "itemType": "lesson", "itemIndex": 4, "title": "世界地图拼图的介绍", "titleEn": "Introduction to the World Map", "slide": 423, "age": "3-6岁", "aim": "把球形的地球仪和作为一种表示地球的方式的二维平面地图联系起来。", "aimEn": "To connect the spherical globe with the two-dimensional flat map as a way of representing the Earth.", "language": "“这是一张拼图，它表示压平的地球。”“这是亚洲，我们住的地方。”", "languageEn": "\"This is a puzzle. It shows the Earth flattened out.\" \"This is Asia, where we live.\""}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'culture'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '地理'
      AND r.title = '世界地图拼图的介绍'
      AND r.description::json->>'itemIndex' = '4'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '各个大洲上的动物', 'Animals sort by continents',
       'prek', 'montessori', 'culture', 'courseware',
       '地理', 'published', t.id, '{"category": "地理", "categoryEn": "Geography", "itemType": "lesson", "itemIndex": 5, "title": "各个大洲上的动物", "titleEn": "Animals sort by continents", "slide": 425, "age": "3-6岁", "aim": "给孩子介绍动物习性和世界的广阔。", "aimEn": "Introduce children to animal habits and the vastness of the world.", "language": "这是我们居住的亚洲，在亚洲也住着很多动物；这是熊猫，它住在中国，它喜欢吃竹子。", "languageEn": "This is Asia, where we live. Many animals also live in Asia. This is the giant panda. It lives in China. It likes eating bamboo."}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'culture'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '地理'
      AND r.title = '各个大洲上的动物'
      AND r.description::json->>'itemIndex' = '5'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '水陆地形盒', 'Land and Water Forms',
       'prek', 'montessori', 'culture', 'courseware',
       '地理', 'published', t.id, '{"category": "地理", "categoryEn": "Geography", "itemType": "lesson", "itemIndex": 6, "title": "水陆地形盒", "titleEn": "Land and Water Forms", "slide": 427, "age": "4-6岁", "aim": "给出地球上陆地形状的印象的。", "aimEn": "Give children an impression of the shapes of land on Earth.", "language": "岛屿/湖泊、海角/海湾、地峡/海峡、半岛/海湾、群岛/湖泊群", "languageEn": "Islan d / Lake, Cape / Bay, Isthmus / Strait, Peninsula / Bay, Archipelago / Group of lakes"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'culture'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '地理'
      AND r.title = '水陆地形盒'
      AND r.description::json->>'itemIndex' = '6'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '水陆地形盒三段卡', 'Land and Water three parts card',
       'prek', 'montessori', 'culture', 'courseware',
       '地理', 'published', t.id, '{"category": "地理", "categoryEn": "Geography", "itemType": "lesson", "itemIndex": 7, "title": "水陆地形盒三段卡", "titleEn": "Land and Water three parts card", "slide": 429, "age": "4-6岁", "aim": "给出地球上陆地形状的印象的。", "aimEn": "Give children an impression of the shapes of land on Earth.", "language": "岛屿/湖泊、海角/海湾、地峡/海峡、半岛/海湾、群岛/湖泊群", "languageEn": "Island / Lake, Cape / Bay, Isthmus / Strait, Peninsula / Bay, Archipelago / Group of lakes"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'culture'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '地理'
      AND r.title = '水陆地形盒三段卡'
      AND r.description::json->>'itemIndex' = '7'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '水陆地形盒定义小书', 'Definition Book for Land and Water Forms',
       'prek', 'montessori', 'culture', 'courseware',
       '地理', 'published', t.id, '{"category": "地理", "categoryEn": "Geography", "itemType": "lesson", "itemIndex": 8, "title": "水陆地形盒定义小书", "titleEn": "Definition Book for Land and Water Forms", "slide": 431, "age": "4-6岁", "aim": "给出地球上陆地形状的印象的。", "aimEn": "Give children an impression of the shapes of land on Earth.", "language": "岛屿/湖泊、海角/海湾、地峡/海峡、半岛/海湾、群岛/湖泊群", "languageEn": "Island / Lake, Cape / Bay, Isthmus / Strait, Peninsula / Bay, Archipelago / Group of lakes"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'culture'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '地理'
      AND r.title = '水陆地形盒定义小书'
      AND r.description::json->>'itemIndex' = '8'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '大洲地理拼图--亚洲', 'Continent Puzzle — Asia',
       'prek', 'montessori', 'culture', 'courseware',
       '地理', 'published', t.id, '{"category": "地理", "categoryEn": "Geography", "itemType": "lesson", "itemIndex": 9, "title": "大洲地理拼图--亚洲", "titleEn": "Continent Puzzle — Asia", "slide": 433, "age": "3-6岁", "aim": "把球形的地球仪和作为一种表示地球方式的二维地图相联系。", "aimEn": "Connect the spherical globe to the two‑dimensional map as a way of representing the Earth.", "language": "国家名称", "languageEn": "Names of countries"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'culture'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '地理'
      AND r.title = '大洲地理拼图--亚洲'
      AND r.description::json->>'itemIndex' = '9'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '大洲文化盒--亚洲', 'Continent Culture Box — Asia',
       'prek', 'montessori', 'culture', 'courseware',
       '地理', 'published', t.id, '{"category": "地理", "categoryEn": "Geography", "itemType": "lesson", "itemIndex": 10, "title": "大洲文化盒--亚洲", "titleEn": "Continent Culture Box — Asia", "slide": 435, "age": "3-6岁", "aim": "给孩子提供人类，陆地和其他国家文化的多种感觉的印象。", "aimEn": "Provide children with multi‑sensory impressions of people, land and cultures of other countries.", "language": "这是亚洲的衣服/钱币/玩具/陶器/游戏", "languageEn": "This is clothing / money / toy / pottery / game from Asia."}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'culture'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '地理'
      AND r.title = '大洲文化盒--亚洲'
      AND r.description::json->>'itemIndex' = '10'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '大洲文化袋--亚洲', 'Continent Culture Bag — Asia',
       'prek', 'montessori', 'culture', 'courseware',
       '地理', 'published', t.id, '{"category": "地理", "categoryEn": "Geography", "itemType": "lesson", "itemIndex": 11, "title": "大洲文化袋--亚洲", "titleEn": "Continent Culture Bag — Asia", "slide": 437, "age": "3-6岁", "aim": "给孩子提供人类，陆地和其他国家文化的多种感觉的印象。", "aimEn": "Provide children with multi‑sensory impressions of people, land and cultures of other countries.", "language": "人文、风景、服饰、食物、节日、建筑", "languageEn": "People & culture, landscapes, costumes, food, festivals, architecture"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'culture'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '地理'
      AND r.title = '大洲文化袋--亚洲'
      AND r.description::json->>'itemIndex' = '11'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '国旗-旗帜', 'Flags',
       'prek', 'montessori', 'culture', 'courseware',
       '地理', 'published', t.id, '{"category": "地理", "categoryEn": "Geography", "itemType": "lesson", "itemIndex": 12, "title": "国旗-旗帜", "titleEn": "Flags", "slide": 439, "age": "4-6岁", "aim": "帮助孩子理解旗帜是作为一个国家和它的人民的象征。学习认识和识别一些世界的旗帜。", "aimEn": "Help children understand that a flag is a symbol of a country and its people. Learn to recognise and identify some flags of the world.", "language": "“这是旗帜。它是一种代表国家的象征。这是中国的旗帜,它代表我们整个国家。人们在节日或庆典上使用像这样的旗帜。大多的这样的旗帜会挂在旗杆上。当人们看到他们的…", "languageEn": "“This is a flag. It is a symbol that stands for a country. This is the flag of China. It represents our whole country. People use flags like this during festivals and celebrations. Most flags of this kind are hung on flagpoles. When people see their national flag, they think of their country.”"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'culture'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '地理'
      AND r.title = '国旗-旗帜'
      AND r.description::json->>'itemIndex' = '12'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '方位 方位的介绍1-南、北', 'Orientation Introduction to Orientation 1 — South and North',
       'prek', 'montessori', 'culture', 'courseware',
       '地理', 'published', t.id, '{"category": "地理", "categoryEn": "Geography", "itemType": "lesson", "itemIndex": 13, "title": "方位 方位的介绍1-南、北", "titleEn": "Orientation Introduction to Orientation 1 — South and North", "slide": 441, "age": "5-6岁", "aim": "给孩子介绍指南针的概念和东,南,西和北的观念。", "aimEn": "Introduce children to the concept of a compass and the ideas of east, south, west and north.", "language": "“这是北极点；这是南极点；在真实的地球上,当我们朝北极点行进时,我们说我们在朝北走；在真实的地球上,当我们朝南极点行进时,我们说我们在朝南走。”", "languageEn": "“This is the North Pole. This is the South Pole. On the real Earth, when we travel toward the North Pole, we say we are heading north. On the real Earth, when we travel toward the South Pole, we say we are heading south.”"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'culture'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '地理'
      AND r.title = '方位 方位的介绍1-南、北'
      AND r.description::json->>'itemIndex' = '13'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '方位 方位的介绍2-东南西北', 'Orientation Introduction to Orientation 2 — East, South, West and North',
       'prek', 'montessori', 'culture', 'courseware',
       '地理', 'published', t.id, '{"category": "地理", "categoryEn": "Geography", "itemType": "lesson", "itemIndex": 14, "title": "方位 方位的介绍2-东南西北", "titleEn": "Orientation Introduction to Orientation 2 — East, South, West and North", "slide": 443, "age": "5-6岁", "aim": "给孩子介绍指南针的概念和东,南,西和北的观念。", "aimEn": "Introduce children to the concept of a compass and the ideas of east, south, west and north.", "language": "东、南、西、北、方位", "languageEn": "East, South, West, North, orientation"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'culture'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '地理'
      AND r.title = '方位 方位的介绍2-东南西北'
      AND r.description::json->>'itemIndex' = '14'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '指南针的介绍', 'The Compass',
       'prek', 'montessori', 'culture', 'courseware',
       '地理', 'published', t.id, '{"category": "地理", "categoryEn": "Geography", "itemType": "lesson", "itemIndex": 15, "title": "指南针的介绍", "titleEn": "The Compass", "slide": 445, "age": "4-6岁", "aim": "认识指南针，知道指南针的基本作用，了解指南针指针固定指向北方。", "aimEn": "Get to know the compass, understand its basic function, and learn that the compass needle always points north.", "language": "指南针、北方、南方、指针、指向", "languageEn": "compass, north, south, needle, point to"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'culture'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '地理'
      AND r.title = '指南针的介绍'
      AND r.description::json->>'itemIndex' = '15'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '地球构造 地球结构（地层）', 'Structure of the Earth Earth’s Layers',
       'prek', 'montessori', 'culture', 'courseware',
       '地理', 'published', t.id, '{"category": "地理", "categoryEn": "Geography", "itemType": "lesson", "itemIndex": 16, "title": "地球构造 地球结构（地层）", "titleEn": "Structure of the Earth Earth’s Layers", "slide": 447, "age": "4-6岁", "aim": "认识地球内部四层结构，知道名称与位置、层次关系", "aimEn": "Recognise the four internal layers of the Earth; learn their names, positions and layered relationships.", "language": "地球、地壳、地幔、外地核、内地核、", "languageEn": "Earth, crust, mantle, outer core, inner core"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'culture'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '地理'
      AND r.title = '地球构造 地球结构（地层）'
      AND r.description::json->>'itemIndex' = '16'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '岩石', 'Rocks',
       'prek', 'montessori', 'culture', 'courseware',
       '地理', 'published', t.id, '{"category": "地理", "categoryEn": "Geography", "itemType": "lesson", "itemIndex": 17, "title": "岩石", "titleEn": "Rocks", "slide": 449, "age": "3-5岁", "aim": "感知不同岩石外观特征，认识 5-6 种常见岩石，学习对应命名。", "aimEn": "Perceive the appearance features of different rocks, recognise 5‑6 common rocks and learn their corresponding names.", "language": "岩石、标本、纹理、颜色、名称", "languageEn": "rock, specimen, texture, colour, name"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'culture'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '地理'
      AND r.title = '岩石'
      AND r.description::json->>'itemIndex' = '17'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '火山', 'Volcano',
       'prek', 'montessori', 'culture', 'courseware',
       '地理', 'published', t.id, '{"category": "地理", "categoryEn": "Geography", "itemType": "lesson", "itemIndex": 18, "title": "火山", "titleEn": "Volcano", "slide": 451, "age": "3-6岁", "aim": "认识火山各组成部分，说出火山结构名称。", "aimEn": "Recognise the different parts of a volcano and name its structures.", "language": "火山、火山口、火山锥、岩浆、熔岩、喷发", "languageEn": "volcano, crater, volcanic cone, magma, lava, eruption"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'culture'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '地理'
      AND r.title = '火山'
      AND r.description::json->>'itemIndex' = '18'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '地球的年龄——黑丝带', 'The Age of the Earth — Black Ribbon',
       'prek', 'montessori', 'culture', 'courseware',
       '历史', 'published', t.id, '{"category": "历史", "categoryEn": "History", "itemType": "lesson", "itemIndex": 1, "title": "地球的年龄——黑丝带", "titleEn": "The Age of the Earth — Black Ribbon", "slide": 454, "age": "3+", "aim": "让孩子直观感受地球漫长的历史，并能将重大事件按时间顺序排列在丝带上。", "aimEn": "Let kids intuitively feel Earth’s long history and arrange major events on the ribbon in time order.", "language": "地球、年龄、46亿年、时间线、化石、人类历史。", "languageEn": "Earth, age, 4.6 billion years, timeline, fossil, human history."}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'culture'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '历史'
      AND r.title = '地球的年龄——黑丝带'
      AND r.description::json->>'itemIndex' = '1'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '过去现在未来——历史文物', 'Past, Present and Future — Historical Relics',
       'prek', 'montessori', 'culture', 'courseware',
       '历史', 'published', t.id, '{"category": "历史", "categoryEn": "History", "itemType": "lesson", "itemIndex": 2, "title": "过去现在未来——历史文物", "titleEn": "Past, Present and Future — Historical Relics", "slide": 456, "age": "3+", "aim": "让孩子通过触摸和观察真实模型，认识不同时期的人类物品，并初步理解“过去”与“现在”的差异。", "aimEn": "Allow children to observe and touch models, recognize items from different eras, and understand the difference between past and present.", "language": "历史、文物、古代、现代、过去、时间、文明、考古、变化。", "languageEn": "history, relics, ancient, modern, past, time, civilization, archaeology, change."}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'culture'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '历史'
      AND r.title = '过去现在未来——历史文物'
      AND r.description::json->>'itemIndex' = '2'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '过去现在未来——事物如何改变（过去、现在、未来）', 'Past, Present and Future — How Things Change',
       'prek', 'montessori', 'culture', 'courseware',
       '历史', 'published', t.id, '{"category": "历史", "categoryEn": "History", "itemType": "lesson", "itemIndex": 3, "title": "过去现在未来——事物如何改变（过去、现在、未来）", "titleEn": "Past, Present and Future — How Things Change", "slide": 458, "age": "3+", "aim": "帮助孩子观察并排列同一事物在不同时间阶段的形态，理解事物会随着时间而改变。", "aimEn": "Guide children to sort items by time and understand things change over time.", "language": "过去、现在、未来、变化、发展、时间顺序、从前、以后。", "languageEn": "past, present, future, change, development, time order, before, later."}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'culture'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '历史'
      AND r.title = '过去现在未来——事物如何改变（过去、现在、未来）'
      AND r.description::json->>'itemIndex' = '3'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '过去现在未来——发明', 'Past, Present and Future — Inventions',
       'prek', 'montessori', 'culture', 'courseware',
       '历史', 'published', t.id, '{"category": "历史", "categoryEn": "History", "itemType": "lesson", "itemIndex": 4, "title": "过去现在未来——发明", "titleEn": "Past, Present and Future — Inventions", "slide": 460, "age": "3+", "aim": "让孩子通过观察和操作模型，认识中国四大发明，并理解它们在过去的重要作用。", "aimEn": "Help children know the Four Great Inventions via model observation and operation, and learn their ancient importance.", "language": "四大发明、造纸术、指南针、火药、活字印刷术、古代、现代、发明。", "languageEn": "Four Great Inventions, papermaking, compass, gunpowder, movable-type printing, ancient, modern, invention."}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'culture'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '历史'
      AND r.title = '过去现在未来——发明'
      AND r.description::json->>'itemIndex' = '4'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '时间的推移（天——时间的连续性）', 'Passage of Time (Day — Continuity of Time)',
       'prek', 'montessori', 'culture', 'courseware',
       '历史', 'published', t.id, '{"category": "历史", "categoryEn": "History", "itemType": "lesson", "itemIndex": 5, "title": "时间的推移（天——时间的连续性）", "titleEn": "Passage of Time (Day — Continuity of Time)", "slide": 462, "age": "4+", "aim": "帮助孩子直观感知“一分钟”这一具体时间单位的长度，理解时间是一刻不停连续流逝的。", "aimEn": "Help children intuitively feel the length of one minute and understand that time flows continuously without stopping.", "language": "一分钟、时间、沙漏、流逝、等待、快慢、连续、结束、开始。", "languageEn": "one minute, time, hourglass, passage, waiting, fast and slow, continuous, end, start."}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'culture'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '历史'
      AND r.title = '时间的推移（天——时间的连续性）'
      AND r.description::json->>'itemIndex' = '5'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '时间的推移（天——每天的日记）', 'Passage of Time (Day — Daily Journal)',
       'prek', 'montessori', 'culture', 'courseware',
       '历史', 'published', t.id, '{"category": "历史", "categoryEn": "History", "itemType": "lesson", "itemIndex": 6, "title": "时间的推移（天——每天的日记）", "titleEn": "Passage of Time (Day — Daily Journal)", "slide": 464, "age": "4+", "aim": "帮助孩子将自己一天的活动按时间先后顺序排列，理解“一天”由连续的时间段组成。", "aimEn": "Guide children to sort daily activities in order and perceive a day as continuous time periods.", "language": "早晨、中午、下午、晚上、先、然后、最后、顺序、一天、时间线。", "languageEn": "morning, noon, afternoon, evening, first, then, finally, sequence, all day, timeline."}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'culture'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '历史'
      AND r.title = '时间的推移（天——每天的日记）'
      AND r.description::json->>'itemIndex' = '6'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '时间的推移（天——日历课程）', 'Passage of Time (Day — Calendar Curriculum)',
       'prek', 'montessori', 'culture', 'courseware',
       '历史', 'published', t.id, '{"category": "历史", "categoryEn": "History", "itemType": "lesson", "itemIndex": 7, "title": "时间的推移（天——日历课程）", "titleEn": "Passage of Time (Day — Calendar Curriculum)", "slide": 466, "age": "3+", "aim": "帮助孩子认识日历的结构，学会查找和标记当天日期，理解“天”如何组成星期、月份和年份", "aimEn": "Help children know calendar structure, find the current date, and learn days form weeks, months and years.", "language": "年、月、日、星期、昨天、今天、明天、日历、日期、顺序", "languageEn": "year, month, day, week, yesterday, today, tomorrow, calendar, date, sequence."}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'culture'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '历史'
      AND r.title = '时间的推移（天——日历课程）'
      AND r.description::json->>'itemIndex' = '7'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '时间的推移（星期嵌板）', 'Passage of Time (Week Puzzle Board)',
       'prek', 'montessori', 'culture', 'courseware',
       '历史', 'published', t.id, '{"category": "历史", "categoryEn": "History", "itemType": "lesson", "itemIndex": 8, "title": "时间的推移（星期嵌板）", "titleEn": "Passage of Time (Week Puzzle Board)", "slide": 468, "age": "5+", "aim": "帮助孩子认识一周七天的名称及其固定顺序，初步理解星期是一个连续的时间循环。", "aimEn": "Help children learn seven weekdays and their fixed order, and understand the weekly time cycle.", "language": "星期一、星期二、星期三、星期四、星期五、星期六、星期日、星期、顺序、昨天、今天、明天。", "languageEn": "Monday, Tuesday, Wednesday, Thursday, Friday, Saturday, Sunday, week, sequence, yesterday, today, tomorrow."}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'culture'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '历史'
      AND r.title = '时间的推移（星期嵌板）'
      AND r.description::json->>'itemIndex' = '8'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '时间的推移（月份嵌板）', 'Passage of Time (Month Puzzle Board)',
       'prek', 'montessori', 'culture', 'courseware',
       '历史', 'published', t.id, '{"category": "历史", "categoryEn": "History", "itemType": "lesson", "itemIndex": 9, "title": "时间的推移（月份嵌板）", "titleEn": "Passage of Time (Month Puzzle Board)", "slide": 470, "age": "5+", "aim": "帮助孩子认识一年十二个月的名称及其固定顺序，理解月份是更长的时间单位。", "aimEn": "Help children master 12 months and their fixed order, and understand month as a long time unit.", "language": "一月、二月、三月、四月、五月、六月、七月、八月、九月、十月、十一月、十二月、月份、顺序、上个月、下个月、季节。", "languageEn": "January, February, March, April, May, June, July, August, September, October, November, December, month, sequence, last month, next month, season."}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'culture'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '历史'
      AND r.title = '时间的推移（月份嵌板）'
      AND r.description::json->>'itemIndex' = '9'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '时间的推移（四季三段卡）', 'Passage of Time (Season Three-part Cards)',
       'prek', 'montessori', 'culture', 'courseware',
       '历史', 'published', t.id, '{"category": "历史", "categoryEn": "History", "itemType": "lesson", "itemIndex": 10, "title": "时间的推移（四季三段卡）", "titleEn": "Passage of Time (Season Three-part Cards)", "slide": 472, "age": "5+", "aim": "帮助孩子认识四季的名称、特征及固定顺序，理解季节是年复一年的循环。", "aimEn": "Help children know four seasons, their features and fixed order, and understand seasonal annual cycle.", "language": "春天、夏天、秋天、冬天、季节、循环、顺序、天气、变化。", "languageEn": "spring, summer, autumn, winter, season, cycle, sequence, weather, change."}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'culture'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '历史'
      AND r.title = '时间的推移（四季三段卡）'
      AND r.description::json->>'itemIndex' = '10'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '时间的推移（年-生命发展过程）', 'Passage of Time (Life Growth Timeline)',
       'prek', 'montessori', 'culture', 'courseware',
       '历史', 'published', t.id, '{"category": "历史", "categoryEn": "History", "itemType": "lesson", "itemIndex": 11, "title": "时间的推移（年-生命发展过程）", "titleEn": "Passage of Time (Life Growth Timeline)", "slide": 474, "age": "5+", "aim": "帮助孩子认识人类生命发展的连续阶段，理解时间推移伴随着身体与能力的变化。", "aimEn": "Help children recognize life stages and understand time brings physical and ability changes.", "language": "婴儿、幼儿、儿童、青少年、成人、老人、出生、成长、变化、年龄、顺序、生命。", "languageEn": "baby, toddler, child, teenager, adult, elder, birth, growth, change, age, sequence, life."}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'culture'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '历史'
      AND r.title = '时间的推移（年-生命发展过程）'
      AND r.description::json->>'itemIndex' = '11'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '时间的推移（生日漫步）', 'Passage of Time (Birthday Walk)',
       'prek', 'montessori', 'culture', 'courseware',
       '历史', 'published', t.id, '{"category": "历史", "categoryEn": "History", "itemType": "lesson", "itemIndex": 12, "title": "时间的推移（生日漫步）", "titleEn": "Passage of Time (Birthday Walk)", "slide": 476, "age": "5+", "aim": "帮助孩子通过身体运动理解地球绕太阳公转一圈就是一“年”，以及生日象征年龄增长一岁。", "aimEn": "Help children know Earth orbiting the Sun is one year, and birthday means getting older.", "language": "生日、地球、太阳、公转、一年、绕圈、年龄、月份、季节、生日漫步。", "languageEn": "birthday, Earth, Sun, revolution, year, circle, age, month, season, birthday walk."}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'culture'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '历史'
      AND r.title = '时间的推移（生日漫步）'
      AND r.description::json->>'itemIndex' = '12'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '读取时间——时钟', 'Time Reading — Clock',
       'prek', 'montessori', 'culture', 'courseware',
       '历史', 'published', t.id, '{"category": "历史", "categoryEn": "History", "itemType": "lesson", "itemIndex": 13, "title": "读取时间——时钟", "titleEn": "Time Reading — Clock", "slide": 478, "age": "5+", "aim": "帮助孩子认识时钟的基本结构，学会读取整点、半点以及简单的分钟时间。", "aimEn": "Help children know clock structure and read o''clock, half past and simple minutes.", "language": "时钟、时针、分针、整点、半点、分钟、小时、几点几分、顺时针。", "languageEn": "clock, hour hand, minute hand, o''clock, half past, minute, hour, time, clockwise."}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'culture'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '历史'
      AND r.title = '读取时间——时钟'
      AND r.description::json->>'itemIndex' = '13'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '国家历史——国家周期/朝代', 'National History — Dynasty Timeline',
       'prek', 'montessori', 'culture', 'courseware',
       '历史', 'published', t.id, '{"category": "历史", "categoryEn": "History", "itemType": "lesson", "itemIndex": 14, "title": "国家历史——国家周期/朝代", "titleEn": "National History — Dynasty Timeline", "slide": 480, "age": "5+", "aim": "帮助孩子认识国家历史中朝代的名称与先后顺序，理解时间推移伴随着朝代的更替。", "aimEn": "Help children learn dynasty names and order, understand dynasty changes over time.", "language": "朝代、历史、古代、近代、现代、时间线、顺序、更替、起源、建国。", "languageEn": "dynasty, history, ancient, modern, timeline, sequence, change, origin, nation."}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'culture'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '历史'
      AND r.title = '国家历史——国家周期/朝代'
      AND r.description::json->>'itemIndex' = '14'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '国家历史——国家庆典', 'National History — National Celebration',
       'prek', 'montessori', 'culture', 'courseware',
       '历史', 'published', t.id, '{"category": "历史", "categoryEn": "History", "itemType": "lesson", "itemIndex": 15, "title": "国家历史——国家庆典", "titleEn": "National History — National Celebration", "slide": 482, "age": "5+", "aim": "帮助孩子掌握国庆节的日期（10月1日），并认识阅兵式、国庆假期、升国旗三种庆典形式。", "aimEn": "Help children remember National Day is on October 1st, and know its celebration forms.", "language": "国庆节、十月一日、阅兵式、国庆假期、升国旗、国旗、国家生日。", "languageEn": "National Day, October 1st, military parade, National Day holiday, flag-raising, national flag, national birthday."}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'culture'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '历史'
      AND r.title = '国家历史——国家庆典'
      AND r.description::json->>'itemIndex' = '15'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '国家历史——节日历史', 'National History — Festival History',
       'prek', 'montessori', 'culture', 'courseware',
       '历史', 'published', t.id, '{"category": "历史", "categoryEn": "History", "itemType": "lesson", "itemIndex": 16, "title": "国家历史——节日历史", "titleEn": "National History — Festival History", "slide": 484, "age": "5+", "aim": "帮助孩子认识中国传统节日的名称、日期及主要习俗，理解节日背后蕴含的历史与文化。", "aimEn": "Help children know the names, dates and customs of traditional festivals, and understand their history and culture.", "language": "春节、端午节、中秋节、清明节、节日、历史、习俗、传统。", "languageEn": "Spring Festival, Dragon Boat Festival, Mid-Autumn Festival, Qingming Festival, festival, history, custom, tradition."}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'culture'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '历史'
      AND r.title = '国家历史——节日历史'
      AND r.description::json->>'itemIndex' = '16'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '三态认识', 'States of Matter Recognition',
       'prek', 'montessori', 'culture', 'courseware',
       '科学', 'published', t.id, '{"category": "科学", "categoryEn": "Science", "itemType": "lesson", "itemIndex": 1, "title": "三态认识", "titleEn": "States of Matter Recognition", "slide": 487, "age": "3+", "aim": "了解固体、液体、气体的概念及中英文名称", "aimEn": "To understand the concepts of solid, liquid and gas, as well as their Chinese and English names.", "language": "固体、液体、气体", "languageEn": "solid, liquid, gas"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'culture'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '科学'
      AND r.title = '三态认识'
      AND r.description::json->>'itemIndex' = '1'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '三态分类（小物品/卡片）', 'Classification of Three States of Matter (Small Objects / Cards)',
       'prek', 'montessori', 'culture', 'courseware',
       '科学', 'published', t.id, '{"category": "科学", "categoryEn": "Science", "itemType": "lesson", "itemIndex": 2, "title": "三态分类（小物品/卡片）", "titleEn": "Classification of Three States of Matter (Small Objects / Cards)", "slide": 489, "age": "3+", "aim": "认识三态图片", "aimEn": "Recognize pictures of the three states of matter.", "language": "气体、固体、液体", "languageEn": "gas, solid, liquid"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'culture'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '科学'
      AND r.title = '三态分类（小物品/卡片）'
      AND r.description::json->>'itemIndex' = '2'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '固体的重量', 'Weight of Solids',
       'prek', 'montessori', 'culture', 'courseware',
       '科学', 'published', t.id, '{"category": "科学", "categoryEn": "Science", "itemType": "lesson", "itemIndex": 3, "title": "固体的重量", "titleEn": "Weight of Solids", "slide": 491, "age": "3+", "aim": "学习称的使用方法，知道固体轻重概念", "aimEn": "Learn how to use the balance scale and understand the concept of light and heavy for solids.", "language": "/", "languageEn": "(None)"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'culture'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '科学'
      AND r.title = '固体的重量'
      AND r.description::json->>'itemIndex' = '3'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '沉与浮', 'Sink and Float',
       'prek', 'montessori', 'culture', 'courseware',
       '科学', 'published', t.id, '{"category": "科学", "categoryEn": "Science", "itemType": "lesson", "itemIndex": 4, "title": "沉与浮", "titleEn": "Sink and Float", "slide": 493, "age": "3+", "aim": "了解沉浮的概念", "aimEn": "Understand the concepts of sinking and floating.", "language": "沉、浮", "languageEn": "sink, float"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'culture'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '科学'
      AND r.title = '沉与浮'
      AND r.description::json->>'itemIndex' = '4'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '影子', 'Shadow',
       'prek', 'montessori', 'culture', 'courseware',
       '科学', 'published', t.id, '{"category": "科学", "categoryEn": "Science", "itemType": "lesson", "itemIndex": 5, "title": "影子", "titleEn": "Shadow", "slide": 495, "age": "3+", "aim": "了解影子的形成条件，知道影子的大小变化和光的角度（距离）有关。", "aimEn": "1.Understand the conditions for shadow formation, and know that changes in shadow size are related to the angle (distance) of light.", "language": "影子、变大、变小", "languageEn": "shadow, get bigger, get smaller"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'culture'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '科学'
      AND r.title = '影子'
      AND r.description::json->>'itemIndex' = '5'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '光的折射——三棱镜', 'Light Refraction - Prism',
       'prek', 'montessori', 'culture', 'courseware',
       '科学', 'published', t.id, '{"category": "科学", "categoryEn": "Science", "itemType": "lesson", "itemIndex": 6, "title": "光的折射——三棱镜", "titleEn": "Light Refraction - Prism", "slide": 497, "age": "3+", "aim": "了解折射的概念，利用三棱镜折射出彩虹", "aimEn": "Understand the concept of refraction and use a prism to refract a rainbow.", "language": "三棱镜 折射出彩虹", "languageEn": "prism, refracting a rainbow"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'culture'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '科学'
      AND r.title = '光的折射——三棱镜'
      AND r.description::json->>'itemIndex' = '6'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '放大镜', 'Magnifying Glass',
       'prek', 'montessori', 'culture', 'courseware',
       '科学', 'published', t.id, '{"category": "科学", "categoryEn": "Science", "itemType": "lesson", "itemIndex": 7, "title": "放大镜", "titleEn": "Magnifying Glass", "slide": 499, "age": "3+", "aim": "会用放大镜聚光，知道放大镜的聚光原理", "aimEn": "Learn to focus light with a magnifying glass and understand the light-gathering principle of the magnifying glass.", "language": "/", "languageEn": "(None)"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'culture'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '科学'
      AND r.title = '放大镜'
      AND r.description::json->>'itemIndex' = '7'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '传声筒', 'Speaking Tube',
       'prek', 'montessori', 'culture', 'courseware',
       '科学', 'published', t.id, '{"category": "科学", "categoryEn": "Science", "itemType": "lesson", "itemIndex": 8, "title": "传声筒", "titleEn": "Speaking Tube", "slide": 501, "age": "3+", "aim": "1.会使用自制传声筒交流。2.了解传声筒的原理。", "aimEn": "s:1.Be able to communicate using the homemade speaking tube.2.Understand the working principle of the speaking tube.", "language": "传声筒", "languageEn": "speaking tube"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'culture'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '科学'
      AND r.title = '传声筒'
      AND r.description::json->>'itemIndex' = '8'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '有磁性没有磁性', 'Magnetic and Non-Magnetic',
       'prek', 'montessori', 'culture', 'courseware',
       '科学', 'published', t.id, '{"category": "科学", "categoryEn": "Science", "itemType": "lesson", "itemIndex": 9, "title": "有磁性没有磁性", "titleEn": "Magnetic and Non-Magnetic", "slide": 503, "age": "3+", "aim": "分类、寻找生活中有磁性和非磁性的物品", "aimEn": "Classify and find magnetic and non-magnetic objects in daily life.", "language": "有磁性的、没有磁性的、磁铁", "languageEn": "magnetic, non-magnetic, magnet"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'culture'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '科学'
      AND r.title = '有磁性没有磁性'
      AND r.description::json->>'itemIndex' = '9'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '相反磁性', 'Opposite Magnetic',
       'prek', 'montessori', 'culture', 'courseware',
       '科学', 'published', t.id, '{"category": "科学", "categoryEn": "Science", "itemType": "lesson", "itemIndex": 10, "title": "相反磁性", "titleEn": "Opposite Magnetic", "slide": 505, "age": "3+", "aim": "了解“同性相斥、异性相吸”的原理", "aimEn": "To understand the principle oflike poles repel, opposite poles attract.", "language": "磁铁、吸在一起、分开了", "languageEn": "—"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'culture'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '科学'
      AND r.title = '相反磁性'
      AND r.description::json->>'itemIndex' = '10'
  );

INSERT INTO resources (title, title_en, program, subject, sub_subject, folder_type, theme, status, uploader_id, description, version)
SELECT '灯泡亮了', 'The Light Bulb Lights Up',
       'prek', 'montessori', 'culture', 'courseware',
       '科学', 'published', t.id, '{"category": "科学", "categoryEn": "Science", "itemType": "lesson", "itemIndex": 11, "title": "灯泡亮了", "titleEn": "The Light Bulb Lights Up", "slide": 507, "age": "3+", "aim": "了解灯泡亮的原理", "aimEn": "Understand the principle of the light bulb lighting up.", "language": "电池，通电，亮，不亮", "languageEn": "battery, power on, light up, not light up"}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'prek' AND r.subject = 'montessori'
      AND COALESCE(r.sub_subject, '') = 'culture'
      AND r.folder_type = 'courseware'
      AND COALESCE(r.theme, '') = '科学'
      AND r.title = '灯泡亮了'
      AND r.description::json->>'itemIndex' = '11'
  );


-- 蒙特梭利非英文区工作项总数：245


-- ============================================================
-- 5. K 英文 - Big Unit Theme 概览 (curriculum_outline)
-- 共 6 个 Theme
-- ============================================================

INSERT INTO resources (title, title_en, program, subject, folder_type, theme, status, uploader_id, description, version)
SELECT '主题1：我自己 - Theme Overview', '主题1：我自己 - Theme Overview',
       'k', 'english', 'curriculum_outline',
       '主题1：我自己', 'published', t.id, '{"code": "23.01", "essentialQuestion": "Who Am I and How Do I Feel?", "essentialQuestionEn": "Who Am I and How Do I Feel?", "updateNote": "6 周；开学适应、情绪与规则，含绘本理解、Guided Reading/Writing 和数学", "updateNoteEn": "6 weeks; school transition, emotions and rules, with picture-book comprehension, guided reading/writing and math", "weekCount": 6, "strandSummary": {"readingComprehension": "Picture-book / text-based comprehension follows fiction or non-fiction lesson sequences, including prediction, initial reading, inference, visualization, discussion and reading response.", "languageSkills": "Language Skills integrate Wonders Guided Reading, phonics and phonological awareness, sight words, leveled readers, conventions, and Guided Writing.", "math": "Math is taught within the same Theme through daily calendar routines, number and operations, geometry, measurement and data, with scheduled assessments."}}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'k' AND r.subject = 'english'
      AND r.folder_type = 'curriculum_outline'
      AND COALESCE(r.theme, '') = '主题1：我自己'
      AND r.title = '主题1：我自己 - Theme Overview'
  );

INSERT INTO resources (title, title_en, program, subject, folder_type, theme, status, uploader_id, description, version)
SELECT '主题2：五感 - Theme Overview', '主题2：五感 - Theme Overview',
       'k', 'english', 'curriculum_outline',
       '主题2：五感', 'published', t.id, '{"code": "23.02", "essentialQuestion": "How do my senses help me to understand the world around me?", "essentialQuestionEn": "How do my senses help me to understand the world around me?", "updateNote": "7 周；五感主题绘本、Wonders 阅读、语言技能与计数数学", "updateNoteEn": "7 weeks; five-senses picture books, Wonders reading, language skills and counting math", "weekCount": 7, "strandSummary": {"readingComprehension": "Picture-book / text-based comprehension follows fiction or non-fiction lesson sequences, including prediction, initial reading, inference, visualization, discussion and reading response.", "languageSkills": "Language Skills integrate Wonders Guided Reading, phonics and phonological awareness, sight words, leveled readers, conventions, and Guided Writing.", "math": "Math is taught within the same Theme through daily calendar routines, number and operations, geometry, measurement and data, with scheduled assessments."}}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'k' AND r.subject = 'english'
      AND r.folder_type = 'curriculum_outline'
      AND COALESCE(r.theme, '') = '主题2：五感'
      AND r.title = '主题2：五感 - Theme Overview'
  );

INSERT INTO resources (title, title_en, program, subject, folder_type, theme, status, uploader_id, description, version)
SELECT '主题3：社区与邻里 - Theme Overview', '主题3：社区与邻里 - Theme Overview',
       'k', 'english', 'curriculum_outline',
       '主题3：社区与邻里', 'published', t.id, '{"code": "23.03", "essentialQuestion": "How do the people and places in the neighborhood help to support our community?", "essentialQuestionEn": "How do the people and places in the neighborhood help to support our community?", "updateNote": "4 周；社区场所、职业、邻里与互助，含绘本、阅读分层和数学比较", "updateNoteEn": "4 weeks; places, jobs, neighbors and community help, with books, leveled reading and number comparison", "weekCount": 4, "strandSummary": {"readingComprehension": "Picture-book / text-based comprehension follows fiction or non-fiction lesson sequences, including prediction, initial reading, inference, visualization, discussion and reading response.", "languageSkills": "Language Skills integrate Wonders Guided Reading, phonics and phonological awareness, sight words, leveled readers, conventions, and Guided Writing.", "math": "Math is taught within the same Theme through daily calendar routines, number and operations, geometry, measurement and data, with scheduled assessments."}}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'k' AND r.subject = 'english'
      AND r.folder_type = 'curriculum_outline'
      AND COALESCE(r.theme, '') = '主题3：社区与邻里'
      AND r.title = '主题3：社区与邻里 - Theme Overview'
  );

INSERT INTO resources (title, title_en, program, subject, folder_type, theme, status, uploader_id, description, version)
SELECT '主题4：自然世界 - Theme Overview', '主题4：自然世界 - Theme Overview',
       'k', 'english', 'curriculum_outline',
       '主题4：自然世界', 'published', t.id, '{"code": "23.04", "essentialQuestion": "How do plants help our planet?", "essentialQuestionEn": "How do plants help our planet?", "updateNote": "4 周；植物生长、农场食物，含绘本理解、自然拼读和加减法启蒙", "updateNoteEn": "4 weeks; plant growth, farms and food, with books, phonics and early addition/subtraction", "weekCount": 4, "strandSummary": {"readingComprehension": "Picture-book / text-based comprehension follows fiction or non-fiction lesson sequences, including prediction, initial reading, inference, visualization, discussion and reading response.", "languageSkills": "Language Skills integrate Wonders Guided Reading, phonics and phonological awareness, sight words, leveled readers, conventions, and Guided Writing.", "math": "Math is taught within the same Theme through daily calendar routines, number and operations, geometry, measurement and data, with scheduled assessments."}}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'k' AND r.subject = 'english'
      AND r.folder_type = 'curriculum_outline'
      AND COALESCE(r.theme, '') = '主题4：自然世界'
      AND r.title = '主题4：自然世界 - Theme Overview'
  );

INSERT INTO resources (title, title_en, program, subject, folder_type, theme, status, uploader_id, description, version)
SELECT '主题5：项目式学习（PBL） - Theme Overview', '主题5：项目式学习（PBL） - Theme Overview',
       'k', 'english', 'curriculum_outline',
       '主题5：项目式学习（PBL）', 'published', t.id, '{"code": "23.05", "essentialQuestion": "", "essentialQuestionEn": "", "updateNote": "9 周；工作簿中 Guided Reading/Writing 与数学已排，绘本理解和成果材料待补", "updateNoteEn": "9 weeks; guided reading/writing and math are mapped; picture-book comprehension and PBL artifacts are pending", "weekCount": 9, "strandSummary": {"readingComprehension": "Picture-book / text-based comprehension follows fiction or non-fiction lesson sequences, including prediction, initial reading, inference, visualization, discussion and reading response.", "languageSkills": "Language Skills integrate Wonders Guided Reading, phonics and phonological awareness, sight words, leveled readers, conventions, and Guided Writing.", "math": "Math is taught within the same Theme through daily calendar routines, number and operations, geometry, measurement and data, with scheduled assessments."}}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'k' AND r.subject = 'english'
      AND r.folder_type = 'curriculum_outline'
      AND COALESCE(r.theme, '') = '主题5：项目式学习（PBL）'
      AND r.title = '主题5：项目式学习（PBL） - Theme Overview'
  );

INSERT INTO resources (title, title_en, program, subject, folder_type, theme, status, uploader_id, description, version)
SELECT '主题6：环游世界 - Theme Overview', '主题6：环游世界 - Theme Overview',
       'k', 'english', 'curriculum_outline',
       '主题6：环游世界', 'published', t.id, '{"code": "23.06", "essentialQuestion": "How are people and places around the world same and different?", "essentialQuestionEn": "How are people and places around the world same and different?", "updateNote": "7 个国家/地区周 + 1 周总结；世界文化绘本、长元音、语言技能与测量数据", "updateNoteEn": "7 country/region weeks plus a summary week; global books, long vowels, language skills and measurement/data", "weekCount": 8, "strandSummary": {"readingComprehension": "Picture-book / text-based comprehension follows fiction or non-fiction lesson sequences, including prediction, initial reading, inference, visualization, discussion and reading response.", "languageSkills": "Language Skills integrate Wonders Guided Reading, phonics and phonological awareness, sight words, leveled readers, conventions, and Guided Writing.", "math": "Math is taught within the same Theme through daily calendar routines, number and operations, geometry, measurement and data, with scheduled assessments."}}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'k' AND r.subject = 'english'
      AND r.folder_type = 'curriculum_outline'
      AND COALESCE(r.theme, '') = '主题6：环游世界'
      AND r.title = '主题6：环游世界 - Theme Overview'
  );


-- ============================================================
-- 6. K 英文 - 周计划条目 (weekly_plans)
-- 共 38 个周/总结条目，分布在 6 个 Theme 下
-- 每周含 Reading Comprehension / Language Skills / Math 三个 strand
-- ============================================================

INSERT INTO resources (title, title_en, program, subject, folder_type, theme, status, uploader_id, description, version)
SELECT '主题1：我自己 - S1 W1', '主题1：我自己 - S1 W1',
       'k', 'english', 'weekly_plans',
       '主题1：我自己', 'published', t.id, '{"column": 2, "weekLabel": "S1 W1", "dateRange": "Aug 24th -28th", "topic": "First Week of School", "focus": "How do you feel about your first week of school?", "calendarNote": "", "readingComprehension": {"book": "Meme''s First Day at School (fiction)", "objectives": ["1A.1a Recognize and name their basic emotions, where they feel them in their bodies, and describe situations that may evoke these emotions."], "lessonStructure": ["Fiction Text: Part 1: Predictions Part 2: Initial Reading Part 3: Making Inferences", "Visualisation", "Discussion Part 4: Reading Response Activity"]}, "guidedReading": {"wondersUnit": "Wonders Smart Start", "topic": "We are Special!", "objectives": ["CCSS.ELA-LITERACY.RF.K.1 Demonstrate understanding of the organization and basic features of print CCSS.ELA-LITERACY.RF.K.1.A Follow words from left to right, top to bottom, and page by page"], "phonics": "Letter Names: A-H", "phonologicalAwareness": ["RF.K.1D Recognise and name all upper- and lowercase letters of the alaphabet"], "sightWords": "I, it", "sightWordsStandard": ["*words in bold orange are from Wonders (includes words from Primer list) total 14 words* *words in blue are from Wonders (includes words from Pre-Primer list) total 22 words* *words in black are in Wonders (but not in Dolch''s sight word list) total 2 words* *words in bold black are NOT in Wonders but are from the Dolch''s pre-primer list* *words in red are NOT in Wonders but are from the Dolch''s primer list"], "leveledReaders": {"approaching": "", "onLevel": "", "beyond": ""}, "preDecodableReader": ""}, "languageSkills": {"skill": "5Ws (Who, What, When, Where, and Why)", "standard": ["L.K.1 Understand and use question words (interrogatives) (e.g., who, what, where, when, why, how)."]}, "guidedWriting": {"unit": "Letter Practice Learning Stations", "standard": [], "learningSequence": ["Small Groups Fine Motor Skills - focus on observing and recording students readiness for writing based on their penmanship, pencil grip, and letter formation - practice letter stroke, pencil grip, and correct direction/sequence of letter formation Aim: identify", "recognise students readiness for writing - differentiated groups can be decided before the start of the Unit 1 Writing topic."]}, "math": {"unit": "Math Daily Calendar & Learning Stations", "topic": "Daily Number Practice: Numbers 0-10", "standard": ["PK.MATH.3. Understands the relationship between numbers and quantities to 10, connects counting to cardinality PK.MATH.3a. When counting objects, says the number names in the standard order, pairing each object with one and only one number name and each number name with one and only one object. (1:1 correspondence) PK.MATH.4b. Given a number from 1-10, counts out that many objects"], "sequence": ["Week 1: Daily Numbers (whole group) Class One = All about numbers 1 & 2 Class Two = All about number 3 & 4 Learning Stations (small group): - Number Formation - Number Recongition - Counting & Cardinality"]}, "assessment": "", "assessmentDetail": []}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'k' AND r.subject = 'english'
      AND r.folder_type = 'weekly_plans'
      AND COALESCE(r.theme, '') = '主题1：我自己'
      AND r.title = '主题1：我自己 - S1 W1'
  );

INSERT INTO resources (title, title_en, program, subject, folder_type, theme, status, uploader_id, description, version)
SELECT '主题1：我自己 - S1 W2', '主题1：我自己 - S1 W2',
       'k', 'english', 'weekly_plans',
       '主题1：我自己', 'published', t.id, '{"column": 3, "weekLabel": "S1 W2", "dateRange": "Aug 31st - Sept 4th", "topic": "Emotions & Feelings", "focus": "What are different emotions that you feel?", "calendarNote": "", "readingComprehension": {"book": "Colour Monster goes to School (fiction)", "objectives": ["1A.2a. Describe a range of emotions and the situations that cause them"], "lessonStructure": ["Fiction Text: Part 1: Predictions Part 2: Initial Reading Part 3: Making Inferences", "Visualisation", "Discussion Part 4: Reading Response Activity"]}, "guidedReading": {"wondersUnit": "Wonders Smart Start", "topic": "My Family & Me", "objectives": ["CCSS.ELA-LITERACY.RF.K.1 Demonstrate understanding of the organization and basic features of print CCSS.ELA-LITERACY.RF.K.1.A Follow words from left to right, top to bottom, and page by page"], "phonics": "Letter Names: I-R", "phonologicalAwareness": ["RF.K.1D Recognise and name all upper- and lowercase letters of the alaphabet"], "sightWords": "can, big", "sightWordsStandard": ["*words in bold orange are from Wonders (includes words from Primer list) total 14 words* *words in blue are from Wonders (includes words from Pre-Primer list) total 22 words* *words in black are in Wonders (but not in Dolch''s sight word list) total 2 words* *words in bold black are NOT in Wonders but are from the Dolch''s pre-primer list* *words in red are NOT in Wonders but are from the Dolch''s primer list"], "leveledReaders": {"approaching": "", "onLevel": "", "beyond": ""}, "preDecodableReader": ""}, "languageSkills": {"skill": "5Ws (Who, What, When, Where, and Why)", "standard": ["L.K.1 Understand and use question words (interrogatives) (e.g., who, what, where, when, why, how)."]}, "guidedWriting": {"unit": "Letter Practice Learning Stations", "standard": [], "learningSequence": ["Small Groups Fine Motor Skills - focus on observing and recording students readiness for writing based on their penmanship, pencil grip, and letter formation - practice letter stroke, pencil grip, and correct direction/sequence of letter formation Aim: identify", "recognise students readiness for writing - differentiated groups can be decided before the start of the Unit 1 Writing topic."]}, "math": {"unit": "Math Daily Calendar & Learning Stations", "topic": "Daily Number Practice: Numbers 0-10", "standard": ["PK.MATH.3. Understands the relationship between numbers and quantities to 10, connects counting to cardinality PK.MATH.3a. When counting objects, says the number names in the standard order, pairing each object with one and only one number name and each number name with one and only one object. (1:1 correspondence) PK.MATH.4b. Given a number from 1-10, counts out that many objects"], "sequence": ["Week 2: Daily Numbers (whole group) Class One = All about nunber 5 & 6 Class Two = All about number 7 & 8 Learning Stations (small group): - Number Formation - Number Recongition - Counting & Cardinality"]}, "assessment": "K Diagnostic Tests (one-to-one)", "assessmentDetail": ["Test 1: Letter Names (A-Z) - ESGI Test 2: Letter Sounds (A-Z) - ESGI"]}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'k' AND r.subject = 'english'
      AND r.folder_type = 'weekly_plans'
      AND COALESCE(r.theme, '') = '主题1：我自己'
      AND r.title = '主题1：我自己 - S1 W2'
  );

INSERT INTO resources (title, title_en, program, subject, folder_type, theme, status, uploader_id, description, version)
SELECT '主题1：我自己 - S1 W3', '主题1：我自己 - S1 W3',
       'k', 'english', 'weekly_plans',
       '主题1：我自己', 'published', t.id, '{"column": 4, "weekLabel": "S1 W3", "dateRange": "Sept 7th - Sept 11th", "topic": "Understanding Emotions", "focus": "Why do we feel different emotions at different times?", "calendarNote": "", "readingComprehension": {"book": "Crankenstein (fiction)", "objectives": ["1B.1.a Identify one''s likes and dislikes, needs, and watnts, strengths and challenges."], "lessonStructure": ["Fiction Text: Part 1: Predictions Part 2: Initial Reading Part 3: Making Inferences", "Visualisation", "Discussion Part 4: Reading Response Activity"]}, "guidedReading": {"wondersUnit": "Wonders Smart Start", "topic": "I Can!", "objectives": ["CCSS.ELA-LITERACY.RF.K.1 Demonstrate understanding of the organization and basic features of print CCSS.ELA-LITERACY.RF.K.1.A Follow words from left to right, top to bottom, and page by page"], "phonics": "Letter Names: S-Z", "phonologicalAwareness": ["RF.K.1D Recognise and name all upper- and lowercase letters of the alaphabet"], "sightWords": "blue, down", "sightWordsStandard": ["*words in bold orange are from Wonders (includes words from Primer list) total 14 words* *words in blue are from Wonders (includes words from Pre-Primer list) total 22 words* *words in black are in Wonders (but not in Dolch''s sight word list) total 2 words* *words in bold black are NOT in Wonders but are from the Dolch''s pre-primer list* *words in red are NOT in Wonders but are from the Dolch''s primer list"], "leveledReaders": {"approaching": "", "onLevel": "", "beyond": ""}, "preDecodableReader": ""}, "languageSkills": {"skill": "5Ws (Who, What, When, Where, and Why)", "standard": ["L.K.1 Understand and use question words (interrogatives) (e.g., who, what, where, when, why, how)."]}, "guidedWriting": {"unit": "Letter Practice Learning Stations", "standard": [], "learningSequence": ["Small Groups Fine Motor Skills - focus on observing and recording students readiness for writing based on their penmanship, pencil grip, and letter formation - practice letter stroke, pencil grip, and correct direction/sequence of letter formation Aim: identify", "recognise students readiness for writing - differentiated groups can be decided before the start of the Unit 1 Writing topic."]}, "math": {"unit": "Math Daily Calendar & Learning Stations", "topic": "Daily Number Practice: Numbers 0-10", "standard": ["PK.MATH.3. Understands the relationship between numbers and quantities to 10, connects counting to cardinality PK.MATH.3a. When counting objects, says the number names in the standard order, pairing each object with one and only one number name and each number name with one and only one object. (1:1 correspondence) PK.MATH.4b. Given a number from 1-10, counts out that many objects"], "sequence": ["Week 3: Daily Numbers (whole group) Class One = All about nunber 9 & 10 Class Two = Review 1-10 Learning Stations (small group): - Number Formation - Number Recongition - Counting & Cardinality"]}, "assessment": "K Diagnostic Tests (one-to-one)", "assessmentDetail": ["Test 3: Identifying Numbers 0-10 Test 4: Sight Words Pre-K (Pre- Primer) 40 List"]}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'k' AND r.subject = 'english'
      AND r.folder_type = 'weekly_plans'
      AND COALESCE(r.theme, '') = '主题1：我自己'
      AND r.title = '主题1：我自己 - S1 W3'
  );

INSERT INTO resources (title, title_en, program, subject, folder_type, theme, status, uploader_id, description, version)
SELECT '主题1：我自己 - S1 W4', '主题1：我自己 - S1 W4',
       'k', 'english', 'weekly_plans',
       '主题1：我自己', 'published', t.id, '{"column": 5, "weekLabel": "S1 W4", "dateRange": "Sept 14th - Sept 18th", "topic": "Regulating Emotions", "focus": "How can you regulate your emotions?", "calendarNote": "", "readingComprehension": {"book": "I Calm Down (fiction)", "objectives": ["2D.1a. Identify problems and conflicts commonly experienced by peers 2D.1b. Identify approaches to resolving conflicts constructively 3B.1b. Make positive choices when interacting with classmates"], "lessonStructure": ["Non-Fiction Text: Part 1: KWL (Know, Want, Learn) Part 2: Intial Reading Part 3: Making Self-Connections", "Discussion Part 4: Reading Response", "L-Learn Activity"]}, "guidedReading": {"wondersUnit": "Unit 1: Take a New Step", "topic": "Make New Friends", "objectives": ["CCSS.ELA-LITERACY.RI.K.4 With prompting and support, ask and answer questions about unknown words CCSS.ELA-LITERACY.RI.K.5 Identify the front cover, back cover, and the title page of a book."], "phonics": "Mm", "phonologicalAwareness": ["RF.K.2 Demonstrate understanding of spoken words, syllables, and sounds (phonemes) RF.K.3 Know and apply grade-level phonics and word analysis skills in decoding words"], "sightWords": "the, find", "sightWordsStandard": ["*words in bold orange are from Wonders (includes words from Primer list) total 14 words* *words in blue are from Wonders (includes words from Pre-Primer list) total 22 words* *words in black are in Wonders (but not in Dolch''s sight word list) total 2 words* *words in bold black are NOT in Wonders but are from the Dolch''s pre-primer list* *words in red are NOT in Wonders but are from the Dolch''s primer list"], "leveledReaders": {"approaching": "Soup", "onLevel": "Mouse and Monkey", "beyond": "Come and play"}, "preDecodableReader": "Take a New Step"}, "languageSkills": {"skill": "5Ws (Who, What, When, Where, and Why)", "standard": ["L.K.1 Understand and use question words (interrogatives) (e.g., who, what, where, when, why, how)."]}, "guidedWriting": {"unit": "Unit 1: Writing with Pictures", "standard": ["W.K.3 Use a combination of drawing, dictating, and writing to narrate a single event or several loosely linked events."], "learningSequence": ["Class One: Introduction Introduce writing with pictures. Students explore materials to draw with. Students explore drawing themselves and include key self detials"]}, "math": {"unit": "Unit 1: Counting & Cardinality", "topic": "Counting Numbers 0-20", "standard": ["KCCB.4 Understand the relationship between numbers and quantities; connect counting to cardinality."], "sequence": []}, "assessment": "K Diagnostic Tests (one-to-one)", "assessmentDetail": ["Test 5: Counting Cardinality 0-20"]}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'k' AND r.subject = 'english'
      AND r.folder_type = 'weekly_plans'
      AND COALESCE(r.theme, '') = '主题1：我自己'
      AND r.title = '主题1：我自己 - S1 W4'
  );

INSERT INTO resources (title, title_en, program, subject, folder_type, theme, status, uploader_id, description, version)
SELECT '主题1：我自己 - S1 W5', '主题1：我自己 - S1 W5',
       'k', 'english', 'weekly_plans',
       '主题1：我自己', 'published', t.id, '{"column": 6, "weekLabel": "S1 W5", "dateRange": "Sep 21st - Sept 24th (4-days)", "topic": "Rules and Postive Behaviour Choices", "focus": "What rules should you follow at school?", "calendarNote": "", "readingComprehension": {"book": "Know & Follow the Rules", "objectives": ["1C.1b. Identify goals for acadmeic success and classroom behaviour 2C.1a. Identify ways to work and play well with others 2C.1b. Demonstrate appropriate social and classroom behaviour"], "lessonStructure": ["Non-Fiction Text: Part 1: KWL (Know, Want, Learn) Part 2: Intial Reading Part 3: Making Self-Connections", "Discussion Part 4: Reading Response", "L-Learn Activity"]}, "guidedReading": {"wondersUnit": "Unit 1: Take a New Step", "topic": "Get Up and Go!", "objectives": ["CCSS.ELA-LITERACY.RI.K.4 With prompting and support, ask and answer questions about unknown words CCSS.ELA-LITERACY.RI.K.5 Identify the front cover, back cover, and the title page of a book."], "phonics": "Aa", "phonologicalAwareness": ["RF.K.2 Demonstrate understanding of spoken words, syllables, and sounds (phonemes) RF.K.3 Know and apply grade-level phonics and word analysis skills in decoding words"], "sightWords": "we, funny", "sightWordsStandard": ["*words in bold orange are from Wonders (includes words from Primer list) total 14 words* *words in blue are from Wonders (includes words from Pre-Primer list) total 22 words* *words in black are in Wonders (but not in Dolch''s sight word list) total 2 words* *words in bold black are NOT in Wonders but are from the Dolch''s pre-primer list* *words in red are NOT in Wonders but are from the Dolch''s primer list"], "leveledReaders": {"approaching": "Hop", "onLevel": "We hop", "beyond": "We can move"}, "preDecodableReader": "Take a New Step"}, "languageSkills": {"skill": "5Ws (Who, What, When, Where, and Why)", "standard": ["L.K.1 Understand and use question words (interrogatives) (e.g., who, what, where, when, why, how)."]}, "guidedWriting": {"unit": "Unit 1: Writing with Pictures", "standard": ["W.K.3 Use a combination of drawing, dictating, and writing to narrate a single event or several loosely linked events."], "learningSequence": ["Class Two: My Likes and Interests Students draw pictures linked to their favourite things, or hobbies, or interests and things they can do."]}, "math": {"unit": "Unit 1: Counting & Cardinality", "topic": "Counting Numbers 0-20", "standard": ["KCCB.4 Understand the relationship between numbers and quantities; connect counting to cardinality."], "sequence": []}, "assessment": "K Diagnostic Tests (one-to-one)", "assessmentDetail": []}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'k' AND r.subject = 'english'
      AND r.folder_type = 'weekly_plans'
      AND COALESCE(r.theme, '') = '主题1：我自己'
      AND r.title = '主题1：我自己 - S1 W5'
  );

INSERT INTO resources (title, title_en, program, subject, folder_type, theme, status, uploader_id, description, version)
SELECT '主题1：我自己 - S1 W6', '主题1：我自己 - S1 W6',
       'k', 'english', 'weekly_plans',
       '主题1：我自己', 'published', t.id, '{"column": 7, "weekLabel": "S1 W6", "dateRange": "Sep 28th - Sept 30th (3-days)", "topic": "Mid-Autumn Festival Celebration", "focus": "How do you celebrate Mid-Autumn Festival?", "calendarNote": "", "readingComprehension": {"book": "Chang''e", "objectives": ["Recognise key details and features of Mid-Autumn traditions - Share connections and experiences to the festival - Re-tell the story of Mid-Autumn sharing key details"], "lessonStructure": ["Non-Fiction Text: Part 1: KWL (Know, Want, Learn) Part 2: Intial Reading Part 3: Making Self-Connections", "Discussion Part 4: Reading Response", "L-Learn Activity"]}, "guidedReading": {"wondersUnit": "", "topic": "", "objectives": [], "phonics": "", "phonologicalAwareness": [], "sightWords": "", "sightWordsStandard": [], "leveledReaders": {"approaching": "", "onLevel": "", "beyond": ""}, "preDecodableReader": ""}, "languageSkills": {"skill": "", "standard": []}, "guidedWriting": {"unit": "Unit 1: Writing with Pictures", "standard": ["W.K.3 Use a combination of drawing, dictating, and writing to narrate a single event or several loosely linked events."], "learningSequence": ["Class Three: My Favorite Foods. Students draw pictures linked to their foods."]}, "math": {"unit": "Unit 1: Counting & Cardinality", "topic": "Counting Numbers 0-20", "standard": ["KCCB.4 Understand the relationship between numbers and quantities; connect counting to cardinality."], "sequence": []}, "assessment": "Assessment", "assessmentDetail": ["Math Recognise Numbers 0-20 ESGi"]}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'k' AND r.subject = 'english'
      AND r.folder_type = 'weekly_plans'
      AND COALESCE(r.theme, '') = '主题1：我自己'
      AND r.title = '主题1：我自己 - S1 W6'
  );

INSERT INTO resources (title, title_en, program, subject, folder_type, theme, status, uploader_id, description, version)
SELECT '主题2：五感 - S1 W7', '主题2：五感 - S1 W7',
       'k', 'english', 'weekly_plans',
       '主题2：五感', 'published', t.id, '{"column": 9, "weekLabel": "S1 W7", "dateRange": "Oct 8th - Oct 9th (2-days)", "topic": "Introduction to the 5 Senses", "focus": "What are my five senses?", "calendarNote": "", "readingComprehension": {"book": "", "objectives": ["SC.K.L.14.1 Recognize the five senses and related body parts"], "lessonStructure": ["Fiction Text: Part 1: Predictions Part 2: Initial Reading Part 3: Making Inferences", "Visualisation", "Discussion Part 4: Reading Response Activity"]}, "guidedReading": {"wondersUnit": "Unit 1: Take a New Step", "topic": "Use Your Senses", "objectives": ["CCSS.ELA-LITERACY.RI.K.6 Name the author and illustrator of a text and define the role of each in presenting the ideas or information in a text (author writes, illustrator draws)"], "phonics": "Ss", "phonologicalAwareness": ["Rhyming RF.K.2a Recognise and produce rhyming words"], "sightWords": "see, away, please", "sightWordsStandard": ["RF.K.3c Read common high-frequency words by sight"], "leveledReaders": {"approaching": "The beach", "onLevel": "At school", "beyond": "See it grow"}, "preDecodableReader": ""}, "languageSkills": {"skill": "Capitalisation (Letter I and beginning of a sentence)", "standard": ["L.K.2 Capitalize the first word in a sentence and the pronoun I."]}, "guidedWriting": {"unit": "Unit 1: Writing with Pictures (contunued)", "standard": ["W.K.3 Use a combination of drawing, dictating, and writing to narrate a single event or several loosely linked events."], "learningSequence": ["Class Four: My Favorite People. Students draw pictures of their family members or friends by labelling, tapping and telling what they drew."]}, "math": {"unit": "Unit 1: Counting and Cardinality", "topic": "Counting to 100", "standard": ["KCCA.1 Count to 100 by ones and by tens. KCCA.2 Count forward beginnng from a given number within the known sequence."], "sequence": []}, "assessment": "", "assessmentDetail": []}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'k' AND r.subject = 'english'
      AND r.folder_type = 'weekly_plans'
      AND COALESCE(r.theme, '') = '主题2：五感'
      AND r.title = '主题2：五感 - S1 W7'
  );

INSERT INTO resources (title, title_en, program, subject, folder_type, theme, status, uploader_id, description, version)
SELECT '主题2：五感 - S1 W8', '主题2：五感 - S1 W8',
       'k', 'english', 'weekly_plans',
       '主题2：五感', 'published', t.id, '{"column": 10, "weekLabel": "S1 W8", "dateRange": "Oct 12th - Oct 16th", "topic": "Sight", "focus": "How does my sense of sight help me?", "calendarNote": "", "readingComprehension": {"book": "Whose Eyes Are These?", "objectives": ["SC.K.L.14.1 Recognize the five senses and related body parts"], "lessonStructure": ["Fiction Text: Part 1: Predictions Part 2: Initial Reading Part 3: Making Inferences", "Visualisation", "Discussion Part 4: Reading Response Activity"]}, "guidedReading": {"wondersUnit": "Unit 2: Let''s Explore!", "topic": "Tools We Use", "objectives": ["CCSS.ELA-LITERACY.RI.K.6 Name the author and illustrator of a text and define the role of each in presenting the ideas or information in a text (author writes, illustrator draws)"], "phonics": "Pp", "phonologicalAwareness": ["Rhyming RF.K.2a Recognise and produce rhyming words"], "sightWords": "a, in, pretty", "sightWordsStandard": ["RF.K.3c Read common high-frequency words by sight"], "leveledReaders": {"approaching": "We need tools", "onLevel": "A trip", "beyond": "What can you see"}, "preDecodableReader": "Let''s Explore!"}, "languageSkills": {"skill": "Capitalisation (Letter I and beginning of a sentence)", "standard": ["L.K.2 Capitalize the first word in a sentence and the pronoun I."]}, "guidedWriting": {"unit": "Unit 1: Writing with Pictures (contunued)", "standard": ["W.K.3 Use a combination of drawing, dictating, and writing to narrate a single event or several loosely linked events."], "learningSequence": ["Class Five: All About Me Student compile their learning to create a drawing based on themsleves - highlighting who they are, who they live with, interest, and things they can do."]}, "math": {"unit": "Unit 1: Counting and Cardinality", "topic": "Skip counting to 100 by 10s", "standard": ["KCCA.1 Count to 100 by ones and by tens. KCCA.2 Count forward beginnng from a given number within the known sequence."], "sequence": []}, "assessment": "", "assessmentDetail": []}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'k' AND r.subject = 'english'
      AND r.folder_type = 'weekly_plans'
      AND COALESCE(r.theme, '') = '主题2：五感'
      AND r.title = '主题2：五感 - S1 W8'
  );

INSERT INTO resources (title, title_en, program, subject, folder_type, theme, status, uploader_id, description, version)
SELECT '主题2：五感 - S1 W9', '主题2：五感 - S1 W9',
       'k', 'english', 'weekly_plans',
       '主题2：五感', 'published', t.id, '{"column": 11, "weekLabel": "S1 W9", "dateRange": "Oct 19th - Oct 23rd", "topic": "Touch", "focus": "What can we learn with the sense of touch?", "calendarNote": "", "readingComprehension": {"book": "The Blind Men and the Elephant", "objectives": ["SC.K.L.14.1 Recognize the five senses and related body parts"], "lessonStructure": ["Fiction Text: Part 1: Predictions Part 2: Initial Reading Part 3: Making Inferences", "Visualisation", "Discussion Part 4: Reading Response Activity"]}, "guidedReading": {"wondersUnit": "Unit 2: Let''s Explore!", "topic": "Shapes All Around Us", "objectives": ["CCSS.ELA-LITERACY.RI.K.6 Name the author and illustrator of a text and define the role of each in presenting the ideas or information in a text (author writes, illustrator draws)"], "phonics": "Tt /t", "phonologicalAwareness": ["Rhyming RF.K.2a Recognise and produce rhyming words"], "sightWords": "like, jump, run", "sightWordsStandard": ["RF.K.3c Read common high-frequency words by sight"], "leveledReaders": {"approaching": "Shapes", "onLevel": "Play with shapes", "beyond": "Use a shape"}, "preDecodableReader": "Let''s Explore!"}, "languageSkills": {"skill": "Capitalisation (Letter I and beginning of a sentence)", "standard": ["L.K.2 Capitalize the first word in a sentence and the pronoun I."]}, "guidedWriting": {"unit": "Unit 1: Writing with Pictures (contunued)", "standard": ["W.K.3 Use a combination of drawing, dictating, and writing to narrate a single event or several loosely linked events."], "learningSequence": ["Class Six: All About Me - finalising details in writing", "labels", "drawing and present to friends in the classroom."]}, "math": {"unit": "Unit 1: Counting and Cardinality", "topic": "Skip counting to 100 by 10s", "standard": ["KCCA.1 Count to 100 by ones and by tens. KCCA.2 Count forward beginnng from a given number within the known sequence."], "sequence": []}, "assessment": "", "assessmentDetail": []}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'k' AND r.subject = 'english'
      AND r.folder_type = 'weekly_plans'
      AND COALESCE(r.theme, '') = '主题2：五感'
      AND r.title = '主题2：五感 - S1 W9'
  );

INSERT INTO resources (title, title_en, program, subject, folder_type, theme, status, uploader_id, description, version)
SELECT '主题2：五感 - S1 W10', '主题2：五感 - S1 W10',
       'k', 'english', 'weekly_plans',
       '主题2：五感', 'published', t.id, '{"column": 12, "weekLabel": "S1 W10", "dateRange": "Oct 26th - Oct 29th", "topic": "Taste", "focus": "What are different tastes?", "calendarNote": "", "readingComprehension": {"book": "Pete the Cat and the Perfect Pizza Party", "objectives": ["SC.K.L.14.1 Recognize the five senses and related body parts"], "lessonStructure": ["Non-Fiction Text: Part 1: KWL (Know, Want, Learn) Part 2: Intial Reading Part 3: Making Self-Connections", "Discussion Part 4: Reading Response", "L-Learn Activity"]}, "guidedReading": {"wondersUnit": "Unit 2: Let''s Explore!", "topic": "World of Bugs", "objectives": ["CCSS.ELA-LITERACY.RI.K.6 Name the author and illustrator of a text and define the role of each in presenting the ideas or information in a text (author writes, illustrator draws)"], "phonics": "Review", "phonologicalAwareness": ["Rhyming RF.K.2a Recognise and produce rhyming words"], "sightWords": "make, not, ride", "sightWordsStandard": ["RF.K.3c Read common high-frequency words by sight"], "leveledReaders": {"approaching": "We like bugs", "onLevel": "The bugs run", "beyond": "I see a bug"}, "preDecodableReader": "Let''s Explore!"}, "languageSkills": {"skill": "Capitalisation (Letter I and beginning of a sentence)", "standard": ["L.K.2 Capitalize the first word in a sentence and the pronoun I."]}, "guidedWriting": {"unit": "Unit 2: Opinion Writing - My Favourite…", "standard": ["W.K.1 Use a combination of drawing, dictating, and wrting to compose opinion pieces in which they tell a reader the topic or the name of the book they are writing about and state an opinion or preference about the topic or book (e.g., My favourite book is...)."], "learningSequence": ["Class One:"]}, "math": {"unit": "Unit 1: Counting and Cardinality", "topic": "Review Week", "standard": ["Review Week"], "sequence": []}, "assessment": "Review Week Assessments", "assessmentDetail": ["Math: Counting to 100 by 1s ESGi Count to 100 by 10s ESGi"]}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'k' AND r.subject = 'english'
      AND r.folder_type = 'weekly_plans'
      AND COALESCE(r.theme, '') = '主题2：五感'
      AND r.title = '主题2：五感 - S1 W10'
  );

INSERT INTO resources (title, title_en, program, subject, folder_type, theme, status, uploader_id, description, version)
SELECT '主题2：五感 - S1 W11', '主题2：五感 - S1 W11',
       'k', 'english', 'weekly_plans',
       '主题2：五感', 'published', t.id, '{"column": 13, "weekLabel": "S1 W11", "dateRange": "Nov 2nd - Nov 6th", "topic": "Hearing/Sound", "focus": "What are the different sounds we can hear?", "calendarNote": "", "readingComprehension": {"book": "Clang! Clang! Beep! Beep!", "objectives": ["SC.K.L.14.1 Recognize the five senses and related body parts"], "lessonStructure": ["Non-Fiction Text: Part 1: KWL (Know, Want, Learn) Part 2: Intial Reading Part 3: Making Self-Connections", "Discussion Part 4: Reading Response", "L-Learn Activity"]}, "guidedReading": {"wondersUnit": "Unit 3: Going Places", "topic": "Rules to Go By", "objectives": ["CCSS.ELA-LITERACY.RI.K.6 Name the author and illustrator of a text and define the role of each in presenting the ideas or information in a text (author writes, illustrator draws)"], "phonics": "Ii", "phonologicalAwareness": ["Rhyming RF.K.2a Recognise and produce rhyming words"], "sightWords": "to, one, saw", "sightWordsStandard": ["RF.K.3c Read common high-frequency words by sight"], "leveledReaders": {"approaching": "We run", "onLevel": "Go, Nat!", "beyond": "The birdhouse"}, "preDecodableReader": "Going Places"}, "languageSkills": {"skill": "Punctuation: Period / Full Stop", "standard": ["L.K.2 Demonstrate command of the conventions of standard English capitalization, punctuation, and spelling when writing. L.K.2b Recognise and name end punctuation"]}, "guidedWriting": {"unit": "Unit 2: Opinion Writing - My Favourite…", "standard": ["W.K.1 Use a combination of drawing, dictating, and wrting to compose opinion pieces in which they tell a reader the topic or the name of the book they are writing about and state an opinion or preference about the topic or book (e.g., My favourite book is...)."], "learningSequence": ["Class Two:"]}, "math": {"unit": "Unit 1: Counting and Cardinality", "topic": "Skip counting to 50 by 5s", "standard": ["KCCA.2 Count forward beginnng from a given number within the known sequence."], "sequence": []}, "assessment": "Assessment", "assessmentDetail": ["Language: Rhyming ESGi"]}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'k' AND r.subject = 'english'
      AND r.folder_type = 'weekly_plans'
      AND COALESCE(r.theme, '') = '主题2：五感'
      AND r.title = '主题2：五感 - S1 W11'
  );

INSERT INTO resources (title, title_en, program, subject, folder_type, theme, status, uploader_id, description, version)
SELECT '主题2：五感 - S1 W12', '主题2：五感 - S1 W12',
       'k', 'english', 'weekly_plans',
       '主题2：五感', 'published', t.id, '{"column": 14, "weekLabel": "S1 W12", "dateRange": "Nov 9th - Nov 13th", "topic": "Smell", "focus": "How do our noses help us to smell?", "calendarNote": "", "readingComprehension": {"book": "What is Smell?", "objectives": ["SC.K.L.14.1 Recognize the five senses and related body parts"], "lessonStructure": ["Non-Fiction Text: Part 1: KWL (Know, Want, Learn) Part 2: Intial Reading Part 3: Making Self-Connections", "Discussion Part 4: Reading Response", "L-Learn Activity"]}, "guidedReading": {"wondersUnit": "Unit 3: Going Places", "topic": "Sounds Around Us", "objectives": ["CCSS.ELA-LITERACY.RI.K.6 Name the author and illustrator of a text and define the role of each in presenting the ideas or information in a text (author writes, illustrator draws)"], "phonics": "Nn", "phonologicalAwareness": ["Syllables RF.K.2b Count, pronounce, blend, and segment syllables in spoken words."], "sightWords": "and, red, say", "sightWordsStandard": ["RF.K.3c Read common high-frequency words by sight"], "leveledReaders": {"approaching": "City sounds", "onLevel": "Farm sounds", "beyond": "A noisy night"}, "preDecodableReader": "Going Places"}, "languageSkills": {"skill": "Punctuation: Question Mark", "standard": ["L.K.2 Demonstrate command of the conventions of standard English capitalization, punctuation, and spelling when writing. L.K.2b Recognise and name end punctuation"]}, "guidedWriting": {"unit": "Unit 2: Opinion Writing - My Favourite…", "standard": ["W.K.1 Use a combination of drawing, dictating, and wrting to compose opinion pieces in which they tell a reader the topic or the name of the book they are writing about and state an opinion or preference about the topic or book (e.g., My favourite book is...)."], "learningSequence": ["Class Three:"]}, "math": {"unit": "Unit 1: Counting and Cardinality", "topic": "Skip counting to 50 by 5s", "standard": ["KCCA.2 Count forward beginnng from a given number within the known sequence."], "sequence": []}, "assessment": "", "assessmentDetail": []}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'k' AND r.subject = 'english'
      AND r.folder_type = 'weekly_plans'
      AND COALESCE(r.theme, '') = '主题2：五感'
      AND r.title = '主题2：五感 - S1 W12'
  );

INSERT INTO resources (title, title_en, program, subject, folder_type, theme, status, uploader_id, description, version)
SELECT '主题2：五感 - S1 W13', '主题2：五感 - S1 W13',
       'k', 'english', 'weekly_plans',
       '主题2：五感', 'published', t.id, '{"column": 15, "weekLabel": "S1 W13", "dateRange": "Nov 16th - Nov 20th", "topic": "Review Week", "focus": "Review - The Five Senses", "calendarNote": "", "readingComprehension": {"book": "", "objectives": ["How we can use our senses to understand the world around us"], "lessonStructure": ["Non-Fiction Text: Part 1: KWL (Know, Want, Learn) Part 2: Intial Reading Part 3: Making Self-Connections", "Discussion Part 4: Reading Response", "L-Learn Activity"]}, "guidedReading": {"wondersUnit": "Unit 3: Going Places", "topic": "The Places We Go", "objectives": ["CCSS.ELA-LITERACY.RI.K.6 Name the author and illustrator of a text and define the role of each in presenting the ideas or information in a text (author writes, illustrator draws)"], "phonics": "Cc /k", "phonologicalAwareness": ["Syllables RF.K.2b Count, pronounce, blend, and segment syllables in spoken words."], "sightWords": "go, run, so", "sightWordsStandard": ["RF.K.3c Read common high-frequency words by sight"], "leveledReaders": {"approaching": "We can go", "onLevel": "Going by cab", "beyond": "Cal''s busy week"}, "preDecodableReader": "Going Places"}, "languageSkills": {"skill": "Punctuation: Exclamation Mark", "standard": ["L.K.2 Demonstrate command of the conventions of standard English capitalization, punctuation, and spelling when writing. L.K.2b Recognise and name end punctuation"]}, "guidedWriting": {"unit": "Unit 2: Opinion Writing - My Favourite…", "standard": ["W.K.1 Use a combination of drawing, dictating, and wrting to compose opinion pieces in which they tell a reader the topic or the name of the book they are writing about and state an opinion or preference about the topic or book (e.g., My favourite book is...)."], "learningSequence": ["Class Four"]}, "math": {"unit": "Unit 1: Counting and Cardinality", "topic": "Skip counting to 20 by 2s", "standard": ["KCCA.2 Count forward beginnng from a given number within the known sequence."], "sequence": []}, "assessment": "", "assessmentDetail": []}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'k' AND r.subject = 'english'
      AND r.folder_type = 'weekly_plans'
      AND COALESCE(r.theme, '') = '主题2：五感'
      AND r.title = '主题2：五感 - S1 W13'
  );

INSERT INTO resources (title, title_en, program, subject, folder_type, theme, status, uploader_id, description, version)
SELECT '主题3：社区与邻里 - S1 W14', '主题3：社区与邻里 - S1 W14',
       'k', 'english', 'weekly_plans',
       '主题3：社区与邻里', 'published', t.id, '{"column": 16, "weekLabel": "S1 W14", "dateRange": "Nov 23rd - Nov 27th", "topic": "Places in My Neighborhood", "focus": "What different places can we see in our neighborhood?", "calendarNote": "", "readingComprehension": {"book": "Places in My Neighborhood", "objectives": ["Name different places in the neighborhood - Make self-connections to the places we can see in our community - Identifty the purposes of places in the neighborhood e.g. places of safety"], "lessonStructure": ["Non-Fiction Text: Part 1: KWL (Know, Want, Learn) Part 2: Intial Reading Part 3: Making Self-Connections", "Discussion Part 4: Reading Response", "L-Learn Activity"]}, "guidedReading": {"wondersUnit": "Unit 4: Around the Neighborhood", "topic": "Time for Work", "objectives": ["CCSS.ELA-LITERACY.RI.K.6 Name the author and illustrator of a text and define the role of each in presenting the ideas or information in a text (author writes, illustrator draws)"], "phonics": "Oo", "phonologicalAwareness": ["Syllables RF.K.2b Count, pronounce, blend, and segment syllables in spoken words."], "sightWords": "you, three, soon", "sightWordsStandard": ["RF.K.3c Read common high-frequency words by sight"], "leveledReaders": {"approaching": "You cook", "onLevel": "On the job", "beyond": "The neighborhood"}, "preDecodableReader": "Around the Neighborhood"}, "languageSkills": {"skill": "Nouns", "standard": ["L.K.1. Use frequently occurring nouns and verbs."]}, "guidedWriting": {"unit": "Unit 2: Opinion Writing - My Favourite…", "standard": ["W.K.1 Use a combination of drawing, dictating, and wrting to compose opinion pieces in which they tell a reader the topic or the name of the book they are writing about and state an opinion or preference about the topic or book (e.g., My favourite book is...)."], "learningSequence": ["Class Five:"]}, "math": {"unit": "Unit 1: Counting and Cardinality", "topic": "Skip counting to 20 by 2s", "standard": ["KCCA.2 Count forward beginnng from a given number within the known sequence."], "sequence": []}, "assessment": "", "assessmentDetail": []}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'k' AND r.subject = 'english'
      AND r.folder_type = 'weekly_plans'
      AND COALESCE(r.theme, '') = '主题3：社区与邻里'
      AND r.title = '主题3：社区与邻里 - S1 W14'
  );

INSERT INTO resources (title, title_en, program, subject, folder_type, theme, status, uploader_id, description, version)
SELECT '主题3：社区与邻里 - S1 W15', '主题3：社区与邻里 - S1 W15',
       'k', 'english', 'weekly_plans',
       '主题3：社区与邻里', 'published', t.id, '{"column": 17, "weekLabel": "S1 W15", "dateRange": "Nov 30th - Dec 4th", "topic": "Community Jobs", "focus": "What different jobs do people do?", "calendarNote": "", "readingComprehension": {"book": "Jobs People Do", "objectives": ["Identify different jobs within the community - Identify the different ways jobs can help us - Identify key tools and features of different jobs"], "lessonStructure": ["Non-Fiction Text: Part 1: KWL (Know, Want, Learn) Part 2: Intial Reading Part 3: Making Self-Connections", "Discussion Part 4: Reading Response", "L-Learn Activity"]}, "guidedReading": {"wondersUnit": "Unit 4: Around the Neighborhood", "topic": "Meet Your Neighbors", "objectives": ["CCSS.ELA-LITERACY.RI.K.6 Name the author and illustrator of a text and define the role of each in presenting the ideas or information in a text (author writes, illustrator draws)"], "phonics": "Dd", "phonologicalAwareness": ["Syllables RF.K.2b Count, pronounce, blend, and segment syllables in spoken words."], "sightWords": "do, two, that", "sightWordsStandard": ["RF.K.3c Read common high-frequency words by sight"], "leveledReaders": {"approaching": "My neighbors", "onLevel": "Neighborhood Party", "beyond": "Parade day"}, "preDecodableReader": "Around the Neighborhood"}, "languageSkills": {"skill": "Nouns", "standard": ["L.K.1. Use frequently occurring nouns and verbs."]}, "guidedWriting": {"unit": "Unit 2: Opinion Writing - My Favourite…", "standard": ["W.K.1 Use a combination of drawing, dictating, and wrting to compose opinion pieces in which they tell a reader the topic or the name of the book they are writing about and state an opinion or preference about the topic or book (e.g., My favourite book is...)."], "learningSequence": ["Class Six:"]}, "math": {"unit": "Unit 1: Counting and Cardinality", "topic": "Comparing Numbers - Greater Than / Less Than / Equal to", "standard": ["K.CC.C.6 Identify whether the number of objects in one group is greater than, less than, or equal to the number of objects in another group, e.g., by using matching and counting strategies."], "sequence": []}, "assessment": "", "assessmentDetail": []}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'k' AND r.subject = 'english'
      AND r.folder_type = 'weekly_plans'
      AND COALESCE(r.theme, '') = '主题3：社区与邻里'
      AND r.title = '主题3：社区与邻里 - S1 W15'
  );

INSERT INTO resources (title, title_en, program, subject, folder_type, theme, status, uploader_id, description, version)
SELECT '主题3：社区与邻里 - S1 W16', '主题3：社区与邻里 - S1 W16',
       'k', 'english', 'weekly_plans',
       '主题3：社区与邻里', 'published', t.id, '{"column": 18, "weekLabel": "S1 W16", "dateRange": "Dec 7th - Dec 11th", "topic": "Neighbors", "focus": "What are neighbors and how can we be a good neighbor?", "calendarNote": "", "readingComprehension": {"book": "The New Neighbors", "objectives": ["Define the key word ''neighbor'' - Identify who are our neighbors -Discuss ways in which we can be ''good'' neighbors"], "lessonStructure": ["Non-Fiction Text: Part 1: KWL (Know, Want, Learn) Part 2: Intial Reading Part 3: Making Self-Connections", "Discussion Part 4: Reading Response", "L-Learn Activity"]}, "guidedReading": {"wondersUnit": "Unit 4: Around the Neighborhood", "topic": "Pitch In", "objectives": ["CCSS.ELA-LITERACY.RI.K.6 Name the author and illustrator of a text and define the role of each in presenting the ideas or information in a text (author writes, illustrator draws)"], "phonics": "Review (assess)", "phonologicalAwareness": ["Syllables RF.K.2b Count, pronounce, blend, and segment syllables in spoken words."], "sightWords": "up, yellow, there", "sightWordsStandard": ["RF.K.3c Read common high-frequency words by sight"], "leveledReaders": {"approaching": "We clean", "onLevel": "We can fix it!", "beyond": "Helping mom"}, "preDecodableReader": "Around the Neighborhood"}, "languageSkills": {"skill": "Nouns", "standard": ["L.K.1. Use frequently occurring nouns and verbs."]}, "guidedWriting": {"unit": "Unit 2: Opinion Writing - My Favourite…", "standard": ["W.K.1 Use a combination of drawing, dictating, and wrting to compose opinion pieces in which they tell a reader the topic or the name of the book they are writing about and state an opinion or preference about the topic or book (e.g., My favourite book is...)."], "learningSequence": ["Class Seven:"]}, "math": {"unit": "Unit 1: Counting and Cardinality", "topic": "Comparing Numbers - Greater Than / Less Than / Equal to", "standard": ["K.CC.C.6 Identify whether the number of objects in one group is greater than, less than, or equal to the number of objects in another group, e.g., by using matching and counting strategies."], "sequence": []}, "assessment": "", "assessmentDetail": []}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'k' AND r.subject = 'english'
      AND r.folder_type = 'weekly_plans'
      AND COALESCE(r.theme, '') = '主题3：社区与邻里'
      AND r.title = '主题3：社区与邻里 - S1 W16'
  );

INSERT INTO resources (title, title_en, program, subject, folder_type, theme, status, uploader_id, description, version)
SELECT '主题3：社区与邻里 - S1 W17', '主题3：社区与邻里 - S1 W17',
       'k', 'english', 'weekly_plans',
       '主题3：社区与邻里', 'published', t.id, '{"column": 19, "weekLabel": "S1 W17", "dateRange": "Dec 14th - Dec 18th", "topic": "Helping the Community", "focus": "How can we help in the community?", "calendarNote": "", "readingComprehension": {"book": "Pete the Cat Saves Christmas", "objectives": ["Identify ways we can help the community - Disucss the concept of neighbors in a broad sense beyond the community"], "lessonStructure": ["Non-Fiction Text: Part 1: KWL (Know, Want, Learn) Part 2: Intial Reading Part 3: Making Self-Connections", "Discussion Part 4: Reading Response", "L-Learn Activity"]}, "guidedReading": {"wondersUnit": "", "topic": "", "objectives": [], "phonics": "", "phonologicalAwareness": [], "sightWords": "", "sightWordsStandard": [], "leveledReaders": {"approaching": "", "onLevel": "", "beyond": ""}, "preDecodableReader": ""}, "languageSkills": {"skill": "", "standard": []}, "guidedWriting": {"unit": "Unit 2: Opinion Writing - My Favourite…", "standard": ["W.K.1 Use a combination of drawing, dictating, and wrting to compose opinion pieces in which they tell a reader the topic or the name of the book they are writing about and state an opinion or preference about the topic or book (e.g., My favourite book is...)."], "learningSequence": []}, "math": {"unit": "Unit 1: Counting and Cardinality", "topic": "Comparing Numbers - Greater Than / Less Than / Equal to", "standard": ["K.CC.C.6 Identify whether the number of objects in one group is greater than, less than, or equal to the number of objects in another group, e.g., by using matching and counting strategies."], "sequence": []}, "assessment": "Review Week Assessments", "assessmentDetail": ["Math: Greater Than", "Less Than", "Equal to - ESGi Literacy: Syllables in spoken words", "rhyming words ESGi"]}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'k' AND r.subject = 'english'
      AND r.folder_type = 'weekly_plans'
      AND COALESCE(r.theme, '') = '主题3：社区与邻里'
      AND r.title = '主题3：社区与邻里 - S1 W17'
  );

INSERT INTO resources (title, title_en, program, subject, folder_type, theme, status, uploader_id, description, version)
SELECT '主题4：自然世界 - S1 W18', '主题4：自然世界 - S1 W18',
       'k', 'english', 'weekly_plans',
       '主题4：自然世界', 'published', t.id, '{"column": 22, "weekLabel": "S1 W18", "dateRange": "Jan 4th - Jan 8th", "topic": "How Does Your Garden Grow?", "focus": "How do plants grow?", "calendarNote": "", "readingComprehension": {"book": "Miguel''s Community Garden", "objectives": ["Identify different types of plants - Disucss key factors that plants need to grow - Begin to discuss how some plants can help us e.g. fruit/food"], "lessonStructure": ["Fiction Text: Part 1: Predictions Part 2: Initial Reading Part 3: Making Inferences", "Visualisation", "Discussion Part 4: Reading Response Activity"]}, "guidedReading": {"wondersUnit": "Unit 5: Wonders of Nature", "topic": "How Does Your Garden Grow?", "objectives": ["CCSS.ELA-LITERACY.RI.K.7 With prompting and support, describe the relationship between illustrations and the text in which they appear (e.g. what person, place, thing, or idea in the text and illustration depicts) CCSS.ELA-LITERACY.RI.K.10 Actively engage in group reading activities with purpose and understanding"], "phonics": "Hh", "phonologicalAwareness": ["Sound Isolation RF.K.2d Isolate and pronounce the initial, medial vowel, and final sounds (phonemes) in there-phoneme (consonant-vowel-consonant, or CVC) words."], "sightWords": "my, all, under", "sightWordsStandard": ["RF.K.3c Read common high-frequency words by sight"], "leveledReaders": {"approaching": "My garden", "onLevel": "My garden grows", "beyond": "The mystery seeds"}, "preDecodableReader": "Wonders of Nature"}, "languageSkills": {"skill": "Verbs & Nouns", "standard": ["L.K.1. Use frequently occurring nouns and verbs."]}, "guidedWriting": {"unit": "Unit 3: Informative Writing TBC", "standard": ["W.K.2 Use a combination of drawing, dictating, and writing to compose informative/explanatory texts in which they name what they are writing about and supply some information about the topic. W.K.6 With guidance and support from adults, explore a variety of digital tools to produce and publish writing, including collaboration with peers."], "learningSequence": ["Class One:"]}, "math": {"unit": "K Unit 2: Operations and Algebraic Thinking", "topic": "Addition (Combine into Operations)", "standard": ["KOA.A1 Represent addition with objects, fingers, mental images, drawings, sounds (e.g. claps), acting out situations, verbal explanations, expressions, or equations. KOA.A3 Decompose numbers less than or equal to 10 into pairs in more than one way, e.g., by using objects or drawings, and record each decompostion by drawing or equation (e.g., 5=2+3 and 5=4+1) K.OA.A.2 Solve addition and subtraction word problems, and add and subtract within 10, e.g., by using objects or drawings to represent the problem."], "sequence": []}, "assessment": "", "assessmentDetail": []}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'k' AND r.subject = 'english'
      AND r.folder_type = 'weekly_plans'
      AND COALESCE(r.theme, '') = '主题4：自然世界'
      AND r.title = '主题4：自然世界 - S1 W18'
  );

INSERT INTO resources (title, title_en, program, subject, folder_type, theme, status, uploader_id, description, version)
SELECT '主题4：自然世界 - S1 W19', '主题4：自然世界 - S1 W19',
       'k', 'english', 'weekly_plans',
       '主题4：自然世界', 'published', t.id, '{"column": 23, "weekLabel": "S1 W19", "dateRange": "Jan 11th - Jan 14th", "topic": "Plant Life", "focus": "How do plants help our planet?", "calendarNote": "", "readingComprehension": {"book": "We Planted a Tree", "objectives": ["Identify key factors needed for plants to grow - Discuss the different ways plants can help us - Identify ways plants can help the planet"], "lessonStructure": ["Fiction Text: Part 1: Predictions Part 2: Initial Reading Part 3: Making Inferences", "Visualisation", "Discussion Part 4: Reading Response Activity"]}, "guidedReading": {"wondersUnit": "Unit 5: Wonders of Nature", "topic": "Trees", "objectives": ["CCSS.ELA-LITERACY.RI.K.7 With prompting and support, describe the relationship between illustrations and the text in which they appear (e.g. what person, place, thing, or idea in the text and illustration depicts) CCSS.ELA-LITERACY.RI.K.10 Actively engage in group reading activities with purpose and understanding"], "phonics": "Ee", "phonologicalAwareness": ["Sound Isolation RF.K.2d Isolate and pronounce the initial, medial vowel, and final sounds (phonemes) in there-phoneme (consonant-vowel-consonant, or CVC) words."], "sightWords": "are, am, want", "sightWordsStandard": ["RF.K.3c Read common high-frequency words by sight"], "leveledReaders": {"approaching": "The tree", "onLevel": "Many trees", "beyond": "Our apple tree"}, "preDecodableReader": "Wonders of Nature"}, "languageSkills": {"skill": "Verbs & Nouns", "standard": ["L.K.1. Use frequently occurring nouns and verbs."]}, "guidedWriting": {"unit": "Unit 3: Informative Writing TBC", "standard": ["W.K.2 Use a combination of drawing, dictating, and writing to compose informative/explanatory texts in which they name what they are writing about and supply some information about the topic. W.K.6 With guidance and support from adults, explore a variety of digital tools to produce and publish writing, including collaboration with peers."], "learningSequence": ["Class Two:"]}, "math": {"unit": "K Unit 2: Operations and Algebraic Thinking", "topic": "Addition (Combine into Operations)", "standard": ["KOA.A1 Represent addition with objects, fingers, mental images, drawings, sounds (e.g. claps), acting out situations, verbal explanations, expressions, or equations. KOA.A3 Decompose numbers less than or equal to 10 into pairs in more than one way, e.g., by using objects or drawings, and record each decompostion by drawing or equation (e.g., 5=2+3 and 5=4+1) K.OA.A.2 Solve addition and subtraction word problems, and add and subtract within 10, e.g., by using objects or drawings to represent the problem."], "sequence": []}, "assessment": "", "assessmentDetail": []}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'k' AND r.subject = 'english'
      AND r.folder_type = 'weekly_plans'
      AND COALESCE(r.theme, '') = '主题4：自然世界'
      AND r.title = '主题4：自然世界 - S1 W19'
  );

INSERT INTO resources (title, title_en, program, subject, folder_type, theme, status, uploader_id, description, version)
SELECT '主题4：自然世界 - S1 W20', '主题4：自然世界 - S1 W20',
       'k', 'english', 'weekly_plans',
       '主题4：自然世界', 'published', t.id, '{"column": 24, "weekLabel": "S1 W20", "dateRange": "Jan 18th - Jan 22nd", "topic": "Farm Fresh", "focus": "Where does food come from?", "calendarNote": "", "readingComprehension": {"book": "Before We Eat", "objectives": ["Discuss where food comes from - Identify that some food types are grown - Identify places that we can find food"], "lessonStructure": ["Non-Fiction Text: Part 1: KWL (Know, Want, Learn) Part 2: Intial Reading Part 3: Making Self-Connections", "Discussion Part 4: Reading Response", "L-Learn Activity"]}, "guidedReading": {"wondersUnit": "Unit 5: Wonders of Nature", "topic": "Fresh from the Farm", "objectives": ["CCSS.ELA-LITERACY.RI.K.7 With prompting and support, describe the relationship between illustrations and the text in which they appear (e.g. what person, place, thing, or idea in the text and illustration depicts) CCSS.ELA-LITERACY.RI.K.10 Actively engage in group reading activities with purpose and understanding"], "phonics": "Ff Rr", "phonologicalAwareness": ["Sound Isolation RF.K.2d Isolate and pronounce the initial, medial vowel, and final sounds (phonemes) in there-phoneme (consonant-vowel-consonant, or CVC) words."], "sightWords": "he, with, well", "sightWordsStandard": ["RF.K.3c Read common high-frequency words by sight"], "leveledReaders": {"approaching": "The Farmer", "onLevel": "Let''s Make a Salad", "beyond": "Farmer Fresh Finn"}, "preDecodableReader": "Wonders of Nature"}, "languageSkills": {"skill": "Verbs & Nouns", "standard": ["L.K.1. Use frequently occurring nouns and verbs."]}, "guidedWriting": {"unit": "Unit 3: Informative Writing TBC", "standard": ["W.K.2 Use a combination of drawing, dictating, and writing to compose informative/explanatory texts in which they name what they are writing about and supply some information about the topic. W.K.6 With guidance and support from adults, explore a variety of digital tools to produce and publish writing, including collaboration with peers."], "learningSequence": ["Class Three:"]}, "math": {"unit": "K Unit 2: Operations and Algebraic Thinking", "topic": "Subtraction (Combine into Operations)", "standard": ["KOA.A1 Represent subtraction with objects, fingers, mental images, drawings, sounds (e.g. claps), acting out situations, verbal explanations, expressions, or equations. KOA.A5 Fluently subtract within 5 KOA.A2 Solve addition and subtraction within 10, e.g., by using objects or drawings to represent the problem. K.OA.A.2 Solve addition and subtraction word problems, and add and subtract within 10, e.g., by using objects or drawings to represent the problem."], "sequence": []}, "assessment": "", "assessmentDetail": []}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'k' AND r.subject = 'english'
      AND r.folder_type = 'weekly_plans'
      AND COALESCE(r.theme, '') = '主题4：自然世界'
      AND r.title = '主题4：自然世界 - S1 W20'
  );

INSERT INTO resources (title, title_en, program, subject, folder_type, theme, status, uploader_id, description, version)
SELECT '主题4：自然世界 - S1 W21', '主题4：自然世界 - S1 W21',
       'k', 'english', 'weekly_plans',
       '主题4：自然世界', 'published', t.id, '{"column": 25, "weekLabel": "S1 W21", "dateRange": "Jan 25th - Jan 29th", "topic": "Review Week", "focus": "", "calendarNote": "", "readingComprehension": {"book": "The Little Red Hen", "objectives": [], "lessonStructure": ["Non-Fiction Text: Part 1: KWL (Know, Want, Learn) Part 2: Intial Reading Part 3: Making Self-Connections", "Discussion Part 4: Reading Response", "L-Learn Activity"]}, "guidedReading": {"wondersUnit": "", "topic": "", "objectives": ["CCSS.ELA-LITERACY.RI.K.7 With prompting and support, describe the relationship between illustrations and the text in which they appear (e.g. what person, place, thing, or idea in the text and illustration depicts) CCSS.ELA-LITERACY.RI.K.10 Actively engage in group reading activities with purpose and understanding"], "phonics": "Bb Ll", "phonologicalAwareness": ["Sound Isolation RF.K.2d Isolate and pronounce the initial, medial vowel, and final sounds (phonemes) in there-phoneme (consonant-vowel-consonant, or CVC) words."], "sightWords": "", "sightWordsStandard": ["RF.K.3c Read common high-frequency words by sight"], "leveledReaders": {"approaching": "It is hot!", "onLevel": "Little bear", "beyond": "Ant and the Grasshopper"}, "preDecodableReader": "Weather for all Seasons"}, "languageSkills": {"skill": "Verbs & Nouns", "standard": ["L.K.1. Use frequently occurring nouns and verbs."]}, "guidedWriting": {"unit": "Unit 3: Informative Writing TBC", "standard": ["W.K.2 Use a combination of drawing, dictating, and writing to compose informative/explanatory texts in which they name what they are writing about and supply some information about the topic. W.K.6 With guidance and support from adults, explore a variety of digital tools to produce and publish writing, including collaboration with peers."], "learningSequence": ["Class Four:"]}, "math": {"unit": "K Unit 2: Operations and Algebraic Thinking", "topic": "Subtraction (Combine into Operations)", "standard": ["KOA.A1 Represent subtraction with objects, fingers, mental images, drawings, sounds (e.g. claps), acting out situations, verbal explanations, expressions, or equations. KOA.A5 Fluently subtract within 5 KOA.A2 Solve addition and subtraction within 10, e.g., by using objects or drawings to represent the problem. K.OA.A.2 Solve addition and subtraction word problems, and add and subtract within 10, e.g., by using objects or drawings to represent the problem."], "sequence": []}, "assessment": "Assessment", "assessmentDetail": ["Language/Literacy Initial, Medial, Ending Sound ESGi"]}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'k' AND r.subject = 'english'
      AND r.folder_type = 'weekly_plans'
      AND COALESCE(r.theme, '') = '主题4：自然世界'
      AND r.title = '主题4：自然世界 - S1 W21'
  );

INSERT INTO resources (title, title_en, program, subject, folder_type, theme, status, uploader_id, description, version)
SELECT '主题5：项目式学习（PBL） - S2 W1', '主题5：项目式学习（PBL） - S2 W1',
       'k', 'english', 'weekly_plans',
       '主题5：项目式学习（PBL）', 'published', t.id, '{"column": 29, "weekLabel": "S2 W1", "dateRange": "Feb 17th - Feb 19th (3-days)", "topic": "PBL Week 1", "focus": "", "calendarNote": "", "readingComprehension": {"book": "", "objectives": [], "lessonStructure": []}, "guidedReading": {"wondersUnit": "Unit 6: Weather for all Seasons", "topic": "The Four Seasons", "objectives": ["CCSS.ELA-LITERACY.RL.K.3 With prompting and support, identify characters, settings, and major events in a story CCSS.ELA-LITERACY.RI.K.9 With prompting and support, identify basic similiarities in and differences between two texts on the same topic"], "phonics": "Bb LL", "phonologicalAwareness": ["Substitution RF.K.2e Add or substitute individual sounds (phonemes) in simpe, one-syllable words to make new words."], "sightWords": "is, little, ate", "sightWordsStandard": ["RF.K.3c Read common high-frequency words by sight"], "leveledReaders": {"approaching": "", "onLevel": "", "beyond": ""}, "preDecodableReader": ""}, "languageSkills": {"skill": "", "standard": []}, "guidedWriting": {"unit": "", "standard": [], "learningSequence": []}, "math": {"unit": "Review Week", "topic": "Addition & Subtraction Practice", "standard": [], "sequence": []}, "assessment": "Math Assessment", "assessmentDetail": ["Add & Subtract within 5 ESGi"]}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'k' AND r.subject = 'english'
      AND r.folder_type = 'weekly_plans'
      AND COALESCE(r.theme, '') = '主题5：项目式学习（PBL）'
      AND r.title = '主题5：项目式学习（PBL） - S2 W1'
  );

INSERT INTO resources (title, title_en, program, subject, folder_type, theme, status, uploader_id, description, version)
SELECT '主题5：项目式学习（PBL） - S2 W2', '主题5：项目式学习（PBL） - S2 W2',
       'k', 'english', 'weekly_plans',
       '主题5：项目式学习（PBL）', 'published', t.id, '{"column": 30, "weekLabel": "S2 W2", "dateRange": "Feb 22nd - Feb 26th", "topic": "PBL Week 2", "focus": "", "calendarNote": "", "readingComprehension": {"book": "", "objectives": [], "lessonStructure": []}, "guidedReading": {"wondersUnit": "Unit 6: Weather for all Seasons", "topic": "What''s the Weather?", "objectives": ["CCSS.ELA-LITERACY.RL.K.3 With prompting and support, identify characters, settings, and major events in a story CCSS.ELA-LITERACY.RI.K.9 With prompting and support, identify basic similiarities in and differences between two texts on the same topic"], "phonics": "Kk ck", "phonologicalAwareness": ["Substitution RF.K.2e Add or substitute individual sounds (phonemes) in simpe, one-syllable words to make new words."], "sightWords": "she, was, be", "sightWordsStandard": ["RF.K.3c Read common high-frequency words by sight"], "leveledReaders": {"approaching": "The rain", "onLevel": "Weather is fun", "beyond": "Kate and Tuck"}, "preDecodableReader": ""}, "languageSkills": {"skill": "Adjectives", "standard": ["L.K.5 Demonstrate understanding of frequently occurring verbs and adjectives by relating them to their opposites (antonyms)."]}, "guidedWriting": {"unit": "Unit 4: Narrative Writing", "standard": ["W.K.7 Participate in shared research and writing projects W.K.3 Use a combination of drawing, dictating, and writing to narrate a single event or several loosely linked events, tell about the events in order in which they occurred, and provide reaction to what happenedW W.K.6 With guidance and support from adults, respond to questions and suggestions from peers and add details to strengthen writing as needed."], "learningSequence": ["Class One:"]}, "math": {"unit": "K Unit 3: Numbers & Operations in Base 10", "topic": "Practice Counting Tens and Ones", "standard": ["Decompose numbers less than or equal to 10 into pairs in more than one way e.g. by using objects or drawings, and record each deomposition by a drawing or equation (e.g., 5 = 2 + 3 and 5 = 4 + 1)"], "sequence": []}, "assessment": "", "assessmentDetail": []}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'k' AND r.subject = 'english'
      AND r.folder_type = 'weekly_plans'
      AND COALESCE(r.theme, '') = '主题5：项目式学习（PBL）'
      AND r.title = '主题5：项目式学习（PBL） - S2 W2'
  );

INSERT INTO resources (title, title_en, program, subject, folder_type, theme, status, uploader_id, description, version)
SELECT '主题5：项目式学习（PBL） - S2 W3', '主题5：项目式学习（PBL） - S2 W3',
       'k', 'english', 'weekly_plans',
       '主题5：项目式学习（PBL）', 'published', t.id, '{"column": 31, "weekLabel": "S2 W3", "dateRange": "Mar 1st - Mar 5th", "topic": "PBL Week 3", "focus": "", "calendarNote": "", "readingComprehension": {"book": "", "objectives": [], "lessonStructure": []}, "guidedReading": {"wondersUnit": "Unit 6: Weather for all Seasons", "topic": "Stormy Weather", "objectives": ["CCSS.ELA-LITERACY.RL.K.3 With prompting and support, identify characters, settings, and major events in a story CCSS.ELA-LITERACY.RI.K.9 With prompting and support, identify basic similiarities in and differences between two texts on the same topic"], "phonics": "Review", "phonologicalAwareness": ["Substitution RF.K.2e Add or substitute individual sounds (phonemes) in simpe, one-syllable words to make new words."], "sightWords": "black, brown, but", "sightWordsStandard": ["RF.K.3c Read common high-frequency words by sight"], "leveledReaders": {"approaching": "Bad weather", "onLevel": "Get ready", "beyond": "The storm"}, "preDecodableReader": ""}, "languageSkills": {"skill": "Adjectives", "standard": ["L.K.5 Demonstrate understanding of frequently occurring verbs and adjectives by relating them to their opposites (antonyms)."]}, "guidedWriting": {"unit": "Unit 4: Narrative Writing", "standard": ["W.K.7 Participate in shared research and writing projects W.K.3 Use a combination of drawing, dictating, and writing to narrate a single event or several loosely linked events, tell about the events in order in which they occurred, and provide reaction to what happenedW W.K.6 With guidance and support from adults, respond to questions and suggestions from peers and add details to strengthen writing as needed."], "learningSequence": ["Class Two:"]}, "math": {"unit": "K Unit 3: Numbers & Operations in Base 10", "topic": "Practice Counting Tens and Ones", "standard": ["KGB.6 Compose and decompose numbers from 11 to 19 into ten ones and some further ones, e.g., by using objects or drawings, and record each composition or decomposition by a drawing or equation (e.g. 18=10+8); understand that these numbers are composed of ten ones and one, two, three, four, five, six, seven, eight, or nine ones."], "sequence": []}, "assessment": "", "assessmentDetail": []}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'k' AND r.subject = 'english'
      AND r.folder_type = 'weekly_plans'
      AND COALESCE(r.theme, '') = '主题5：项目式学习（PBL）'
      AND r.title = '主题5：项目式学习（PBL） - S2 W3'
  );

INSERT INTO resources (title, title_en, program, subject, folder_type, theme, status, uploader_id, description, version)
SELECT '主题5：项目式学习（PBL） - S2 W4', '主题5：项目式学习（PBL） - S2 W4',
       'k', 'english', 'weekly_plans',
       '主题5：项目式学习（PBL）', 'published', t.id, '{"column": 32, "weekLabel": "S2 W4", "dateRange": "Mar 8th - Mar 12th", "topic": "PBL Week 4", "focus": "", "calendarNote": "", "readingComprehension": {"book": "", "objectives": [], "lessonStructure": []}, "guidedReading": {"wondersUnit": "Unit 7: The Animal Kingdom", "topic": "Baby Animals", "objectives": ["CCSS.ELA-LITERACY.RL.K.3 With prompting and support, identify characters, settings, and major events in a story CCSS.ELA-LITERACY.RI.K.9 With prompting and support, identify basic similiarities in and differences between two texts on the same topic"], "phonics": "Uu", "phonologicalAwareness": ["Substitution RF.K.2e Add or substitute individual sounds (phonemes) in simpe, one-syllable words to make new words."], "sightWords": "for, have, came", "sightWordsStandard": ["RF.K.3c Read common high-frequency words by sight"], "leveledReaders": {"approaching": "Two cubs", "onLevel": "Animal Bodies", "beyond": "Two kinds of bears"}, "preDecodableReader": "The Animal Kingdom"}, "languageSkills": {"skill": "Adjectives", "standard": ["L.K.5 Demonstrate understanding of frequently occurring verbs and adjectives by relating them to their opposites (antonyms)."]}, "guidedWriting": {"unit": "Unit 4: Narrative Writing", "standard": ["W.K.7 Participate in shared research and writing projects W.K.3 Use a combination of drawing, dictating, and writing to narrate a single event or several loosely linked events, tell about the events in order in which they occurred, and provide reaction to what happenedW W.K.6 With guidance and support from adults, respond to questions and suggestions from peers and add details to strengthen writing as needed."], "learningSequence": ["Class Three:"]}, "math": {"unit": "K Unit 3: Numbers & Operations in Base 10", "topic": "Practice Counting Tens and Ones", "standard": ["KGB.6 Compose and decompose numbers from 11 to 19 into ten ones and some further ones, e.g., by using objects or drawings, and record each composition or decomposition by a drawing or equation (e.g. 18=10+8); understand that these numbers are composed of ten ones and one, two, three, four, five, six, seven, eight, or nine ones."], "sequence": []}, "assessment": "", "assessmentDetail": []}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'k' AND r.subject = 'english'
      AND r.folder_type = 'weekly_plans'
      AND COALESCE(r.theme, '') = '主题5：项目式学习（PBL）'
      AND r.title = '主题5：项目式学习（PBL） - S2 W4'
  );

INSERT INTO resources (title, title_en, program, subject, folder_type, theme, status, uploader_id, description, version)
SELECT '主题5：项目式学习（PBL） - S2 W5', '主题5：项目式学习（PBL） - S2 W5',
       'k', 'english', 'weekly_plans',
       '主题5：项目式学习（PBL）', 'published', t.id, '{"column": 33, "weekLabel": "S2 W5", "dateRange": "Mar 15th - Mar 19th", "topic": "PBL Week 5", "focus": "", "calendarNote": "", "readingComprehension": {"book": "", "objectives": [], "lessonStructure": []}, "guidedReading": {"wondersUnit": "Unit 7: The Animal Kingdom", "topic": "Pet Pals", "objectives": ["CCSS.ELA-LITERACY.RL.K.3 With prompting and support, identify characters, settings, and major events in a story CCSS.ELA-LITERACY.RI.K.9 With prompting and support, identify basic similiarities in and differences between two texts on the same topic"], "phonics": "Gg Ww", "phonologicalAwareness": ["Substitution RF.K.2e Add or substitute individual sounds (phonemes) in simpe, one-syllable words to make new words."], "sightWords": "they, of (first grade), did", "sightWordsStandard": ["RF.K.3c Read common high-frequency words by sight"], "leveledReaders": {"approaching": "My cats", "onLevel": "Their pets", "beyond": "Will''s Pet"}, "preDecodableReader": "The Animal Kingdom"}, "languageSkills": {"skill": "Opposites", "standard": ["L.K.5 Demonstrate understanding of frequently occurring verbs and adjectives by relating them to their opposites (antonyms)."]}, "guidedWriting": {"unit": "Unit 4: Narrative Writing", "standard": ["W.K.7 Participate in shared research and writing projects W.K.3 Use a combination of drawing, dictating, and writing to narrate a single event or several loosely linked events, tell about the events in order in which they occurred, and provide reaction to what happenedW W.K.6 With guidance and support from adults, respond to questions and suggestions from peers and add details to strengthen writing as needed."], "learningSequence": ["Class Four:"]}, "math": {"unit": "K Unit 4: Geometry", "topic": "2D Shapes: Names & Attributes", "standard": ["KGA.1 Describe objects in the enivornment using names of shapes KGA.2 Correctly name shapes regardless of their orientations or overall size KGA.3 Identify shapes as two-dimensional (lying in a plane, \"flat\") KGB.4 Analyse and compare two-dimensional shapes in different sizes and orientations, using formal language to describe their similarities, differences, parts (e.g. number of sides and vertices/\"corners\") and other attributes (e.g., having sides of equal length)."], "sequence": ["Names: square, circle, triangle, rectangle, hexagon, rhombus Attributes: sides and vertices"]}, "assessment": "", "assessmentDetail": []}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'k' AND r.subject = 'english'
      AND r.folder_type = 'weekly_plans'
      AND COALESCE(r.theme, '') = '主题5：项目式学习（PBL）'
      AND r.title = '主题5：项目式学习（PBL） - S2 W5'
  );

INSERT INTO resources (title, title_en, program, subject, folder_type, theme, status, uploader_id, description, version)
SELECT '主题5：项目式学习（PBL） - S2 W6', '主题5：项目式学习（PBL） - S2 W6',
       'k', 'english', 'weekly_plans',
       '主题5：项目式学习（PBL）', 'published', t.id, '{"column": 34, "weekLabel": "S2 W6", "dateRange": "Mar 22nd - Mar 25th (4-days)", "topic": "PBL Week 6", "focus": "", "calendarNote": "Mar 26th - PD Day", "readingComprehension": {"book": "", "objectives": [], "lessonStructure": []}, "guidedReading": {"wondersUnit": "Unit 7: The Animal Kingdom", "topic": "Animal Habitats", "objectives": ["CCSS.ELA-LITERACY.RL.K.3 With prompting and support, identify characters, settings, and major events in a story CCSS.ELA-LITERACY.RI.K.9 With prompting and support, identify basic similiarities in and differences between two texts on the same topic"], "phonics": "Vv Xx", "phonologicalAwareness": ["Substitution RF.K.2e Add or substitute individual sounds (phonemes) in simpe, one-syllable words to make new words."], "sightWords": "said, want, eat", "sightWordsStandard": ["RF.K.3c Read common high-frequency words by sight"], "leveledReaders": {"approaching": "We want water", "onLevel": "A New Home", "beyond": "Bird''s New Home"}, "preDecodableReader": "The Animal Kingdom"}, "languageSkills": {"skill": "Opposites", "standard": ["L.K.5 Demonstrate understanding of frequently occurring verbs and adjectives by relating them to their opposites (antonyms)."]}, "guidedWriting": {"unit": "Unit 4: Narrative Writing", "standard": ["W.K.7 Participate in shared research and writing projects W.K.3 Use a combination of drawing, dictating, and writing to narrate a single event or several loosely linked events, tell about the events in order in which they occurred, and provide reaction to what happenedW W.K.6 With guidance and support from adults, respond to questions and suggestions from peers and add details to strengthen writing as needed."], "learningSequence": ["Class Five:"]}, "math": {"unit": "K Unit 4: Geometry", "topic": "2D Shapes: Names & Attributes", "standard": ["KGA.1 Describe objects in the enivornment using names of shapes KGA.2 Correctly name shapes regardless of their orientations or overall size KGA.3 Identify shapes as two-dimensional (lying in a plane, \"flat\") KGB.4 Analyse and compare two-dimensional shapes in different sizes and orientations, using formal language to describe their similarities, differences, parts (e.g. number of sides and vertices/\"corners\") and other attributes (e.g., having sides of equal length)."], "sequence": []}, "assessment": "", "assessmentDetail": []}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'k' AND r.subject = 'english'
      AND r.folder_type = 'weekly_plans'
      AND COALESCE(r.theme, '') = '主题5：项目式学习（PBL）'
      AND r.title = '主题5：项目式学习（PBL） - S2 W6'
  );

INSERT INTO resources (title, title_en, program, subject, folder_type, theme, status, uploader_id, description, version)
SELECT '主题5：项目式学习（PBL） - S2 W7', '主题5：项目式学习（PBL） - S2 W7',
       'k', 'english', 'weekly_plans',
       '主题5：项目式学习（PBL）', 'published', t.id, '{"column": 35, "weekLabel": "S2 W7", "dateRange": "Mar 29th - Apr 2nd", "topic": "PBL Week 7", "focus": "", "calendarNote": "", "readingComprehension": {"book": "", "objectives": [], "lessonStructure": []}, "guidedReading": {"wondersUnit": "Unit 8: From Here to There", "topic": "On the Move", "objectives": ["CCSS.ELA-LITERACY.RL.K.3 With prompting and support, identify characters, settings, and major events in a story CCSS.ELA-LITERACY.RI.K.9 With prompting and support, identify basic similiarities in and differences between two texts on the same topic"], "phonics": "Jj qu", "phonologicalAwareness": ["Substitution RF.K.2e Add or substitute individual sounds (phonemes) in simpe, one-syllable words to make new words."], "sightWords": "here, me, four", "sightWordsStandard": ["RF.K.3c Read common high-frequency words by sight"], "leveledReaders": {"approaching": "I go places", "onLevel": "Run Quinn", "beyond": "Going to Gran''s House"}, "preDecodableReader": "From Here to There"}, "languageSkills": {"skill": "Opposites", "standard": ["L.K.5 Demonstrate understanding of frequently occurring verbs and adjectives by relating them to their opposites (antonyms)."]}, "guidedWriting": {"unit": "Unit 4: Narrative Writing", "standard": ["W.K.7 Participate in shared research and writing projects W.K.3 Use a combination of drawing, dictating, and writing to narrate a single event or several loosely linked events, tell about the events in order in which they occurred, and provide reaction to what happenedW W.K.6 With guidance and support from adults, respond to questions and suggestions from peers and add details to strengthen writing as needed."], "learningSequence": ["Class Six"]}, "math": {"unit": "K Unit 4: Geometry", "topic": "3D Shapes: Names & Attributes", "standard": ["KGA.2 Correctly name shapes regardless of their orientations or overall size KGA.3 Identify shapes as three-dimensional (\"solid\") KGB.4 Analyse and compare two-dimensional shapes in different sizes and orientations, using formal language to describe their similarities, differences, parts (e.g. number of sides and vertices/\"corners\") and other attributes (e.g., having sides of equal length)."], "sequence": ["Names: cube, cone, cylinder, pyramid, sphere Attributes: faces, sides, and vertices"]}, "assessment": "", "assessmentDetail": []}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'k' AND r.subject = 'english'
      AND r.folder_type = 'weekly_plans'
      AND COALESCE(r.theme, '') = '主题5：项目式学习（PBL）'
      AND r.title = '主题5：项目式学习（PBL） - S2 W7'
  );

INSERT INTO resources (title, title_en, program, subject, folder_type, theme, status, uploader_id, description, version)
SELECT '主题5：项目式学习（PBL） - S2 W8', '主题5：项目式学习（PBL） - S2 W8',
       'k', 'english', 'weekly_plans',
       '主题5：项目式学习（PBL）', 'published', t.id, '{"column": 36, "weekLabel": "S2 W8", "dateRange": "Apr 6th - Apr 9th (4-days)", "topic": "PBL Week 8", "focus": "", "calendarNote": "", "readingComprehension": {"book": "", "objectives": [], "lessonStructure": []}, "guidedReading": {"wondersUnit": "Unit 8: From Here to There", "topic": "Travel", "objectives": ["CCSS.ELA-LITERACY.RL.K.3 With prompting and support, identify characters, settings, and major events in a story CCSS.ELA-LITERACY.RI.K.9 With prompting and support, identify basic similiarities in and differences between two texts on the same topic"], "phonics": "Yy Zz", "phonologicalAwareness": ["Substitution RF.K.2e Add or substitute individual sounds (phonemes) in simpe, one-syllable words to make new words."], "sightWords": "this, what, get", "sightWordsStandard": ["RF.K.3c Read common high-frequency words by sight"], "leveledReaders": {"approaching": "See this", "onLevel": "Places to see", "beyond": "My trip to Yellowstone"}, "preDecodableReader": "From Here to There"}, "languageSkills": {"skill": "Prepositions", "standard": ["L.K.1.E Use the most frequently occuring prepositions (e.g., to, from, in, out, on, off, for, of, by, with)"]}, "guidedWriting": {"unit": "Unit 4: Narrative Writing", "standard": ["W.K.7 Participate in shared research and writing projects W.K.3 Use a combination of drawing, dictating, and writing to narrate a single event or several loosely linked events, tell about the events in order in which they occurred, and provide reaction to what happenedW W.K.6 With guidance and support from adults, respond to questions and suggestions from peers and add details to strengthen writing as needed."], "learningSequence": ["Class Seven:"]}, "math": {"unit": "K Unit 4: Geometry", "topic": "3D Shapes: Names & Attributes", "standard": ["KGA.2 Correctly name shapes regardless of their orientations or overall size KGA.3 Identify shapes as three-dimensional (\"solid\") KGB.4 Analyse and compare two-dimensional shapes in different sizes and orientations, using formal language to describe their similarities, differences, parts (e.g. number of sides and vertices/\"corners\") and other attributes (e.g., having sides of equal length)."], "sequence": []}, "assessment": "Math Assessment", "assessmentDetail": ["2D/3D Shapes - ESGi"]}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'k' AND r.subject = 'english'
      AND r.folder_type = 'weekly_plans'
      AND COALESCE(r.theme, '') = '主题5：项目式学习（PBL）'
      AND r.title = '主题5：项目式学习（PBL） - S2 W8'
  );

INSERT INTO resources (title, title_en, program, subject, folder_type, theme, status, uploader_id, description, version)
SELECT '主题5：项目式学习（PBL） - S2 W9', '主题5：项目式学习（PBL） - S2 W9',
       'k', 'english', 'weekly_plans',
       '主题5：项目式学习（PBL）', 'published', t.id, '{"column": 37, "weekLabel": "S2 W9", "dateRange": "Apr 12th - Apr 16th", "topic": "PBL Week 9", "focus": "Presentation Week", "calendarNote": "", "readingComprehension": {"book": "", "objectives": [], "lessonStructure": []}, "guidedReading": {"wondersUnit": "Unit 8: From Here to There", "topic": "Look to the Sky!", "objectives": ["CCSS.ELA-LITERACY.RL.K.3 With prompting and support, identify characters, settings, and major events in a story CCSS.ELA-LITERACY.RI.K.9 With prompting and support, identify basic similiarities in and differences between two texts on the same topic"], "phonics": "Review", "phonologicalAwareness": ["Substitution RF.K.2e Add or substitute individual sounds (phonemes) in simpe, one-syllable words to make new words."], "sightWords": "into, must, new", "sightWordsStandard": ["RF.K.3c Read common high-frequency words by sight"], "leveledReaders": {"approaching": "Going up", "onLevel": "In the clouds", "beyond": "How sun & moon found home"}, "preDecodableReader": "From Here to There"}, "languageSkills": {"skill": "Prepositions", "standard": ["L.K.1.E Use the most frequently occuring prepositions (e.g., to, from, in, out, on, off, for, of, by, with)"]}, "guidedWriting": {"unit": "Unit 4: Narrative Writing", "standard": ["W.K.7 Participate in shared research and writing projects W.K.3 Use a combination of drawing, dictating, and writing to narrate a single event or several loosely linked events, tell about the events in order in which they occurred, and provide reaction to what happenedW W.K.6 With guidance and support from adults, respond to questions and suggestions from peers and add details to strengthen writing as needed."], "learningSequence": ["Class Eight:"]}, "math": {"unit": "K Unit 4: Geometry", "topic": "Composing Shapes", "standard": ["KGB.5 Model shapes in the world by building shapes from components (e.g., sticks and clay balls) and drawing shapes. KGB.6 Compose simple shapes to form larger shapes. For example, \"Can you join these two triangle with full sides touching to make a rectangle?\""], "sequence": []}, "assessment": "", "assessmentDetail": []}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'k' AND r.subject = 'english'
      AND r.folder_type = 'weekly_plans'
      AND COALESCE(r.theme, '') = '主题5：项目式学习（PBL）'
      AND r.title = '主题5：项目式学习（PBL） - S2 W9'
  );

INSERT INTO resources (title, title_en, program, subject, folder_type, theme, status, uploader_id, description, version)
SELECT '主题6：环游世界 - S2 W10', '主题6：环游世界 - S2 W10',
       'k', 'english', 'weekly_plans',
       '主题6：环游世界', 'published', t.id, '{"column": 38, "weekLabel": "S2 W10", "dateRange": "Apr 19th - Apr 22nd (4-days)", "topic": "Africa - Kenya", "focus": "", "calendarNote": "Apr 23rd - 24th - One-to-One Parents Meetings", "readingComprehension": {"book": "Handa''s Surprise", "objectives": [], "lessonStructure": ["Fiction Text: Part 1: Predictions Part 2: Initial Reading Part 3: Making Inferences", "Visualisation", "Discussion Part 4: Reading Response Activity"]}, "guidedReading": {"wondersUnit": "Unit 9: How Things Change", "topic": "Growing Up", "objectives": [], "phonics": "Long a", "phonologicalAwareness": ["RF.K.3b Associate the long and short sounds with the common spellings for the five major vowels"], "sightWords": "help, too, no", "sightWordsStandard": ["RF.K.3c Read common high-frequency words by sight"], "leveledReaders": {"approaching": "Let me help you", "onLevel": "How can Jane help?", "beyond": "I used to help too"}, "preDecodableReader": "How Things Change"}, "languageSkills": {"skill": "Prepositions", "standard": ["L.K.1.E Use the most frequently occuring prepositions (e.g., to, from, in, out, on, off, for, of, by, with)"]}, "guidedWriting": {"unit": "", "standard": [], "learningSequence": []}, "math": {"unit": "K Unit 4: Geometry", "topic": "Shape Prepositions", "standard": ["KGA.1 Describe objects in the environment using names of shapes, and describe the relative positions of these objects using terms such as above, below, beside, in front of, behind, next to"], "sequence": []}, "assessment": "", "assessmentDetail": []}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'k' AND r.subject = 'english'
      AND r.folder_type = 'weekly_plans'
      AND COALESCE(r.theme, '') = '主题6：环游世界'
      AND r.title = '主题6：环游世界 - S2 W10'
  );

INSERT INTO resources (title, title_en, program, subject, folder_type, theme, status, uploader_id, description, version)
SELECT '主题6：环游世界 - S2 W11', '主题6：环游世界 - S2 W11',
       'k', 'english', 'weekly_plans',
       '主题6：环游世界', 'published', t.id, '{"column": 39, "weekLabel": "S2 W11", "dateRange": "Apr 26th - Apr 29th (4-days)", "topic": "South America - Peru", "focus": "", "calendarNote": "Apr 30th - May 4th - Labour Day", "readingComprehension": {"book": "Where in the World?", "objectives": [], "lessonStructure": ["Fiction Text: Part 1: Predictions Part 2: Initial Reading Part 3: Making Inferences", "Visualisation", "Discussion Part 4: Reading Response Activity"]}, "guidedReading": {"wondersUnit": "Unit 9: How Things Change", "topic": "Good Citizens", "objectives": [], "phonics": "Long i", "phonologicalAwareness": ["RF.K.3b Associate the long and short sounds with the common spellings for the five major vowels"], "sightWords": "play, has (first grade), now", "sightWordsStandard": ["RF.K.3c Read common high-frequency words by sight"], "leveledReaders": {"approaching": "Mike helps out", "onLevel": "Clive and his friends", "beyond": "Farmer White''s best friend"}, "preDecodableReader": "How Things Change"}, "languageSkills": {"skill": "Prefixes & Suffixes", "standard": ["L.K.4 Use the most frequently occurring inflections and affixes (e.g., -ed, -s, re-, un-, pre-, -ful, -less) as a clue to the meaning of an unknown word."]}, "guidedWriting": {"unit": "", "standard": [], "learningSequence": []}, "math": {"unit": "K Unit 4: Geometry", "topic": "Review Week", "standard": ["Review Week"], "sequence": []}, "assessment": "Review Week Assessments", "assessmentDetail": ["Math: Shape Prepositions - ESGi Decompose Numbers - ESGi"]}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'k' AND r.subject = 'english'
      AND r.folder_type = 'weekly_plans'
      AND COALESCE(r.theme, '') = '主题6：环游世界'
      AND r.title = '主题6：环游世界 - S2 W11'
  );

INSERT INTO resources (title, title_en, program, subject, folder_type, theme, status, uploader_id, description, version)
SELECT '主题6：环游世界 - S2 W12', '主题6：环游世界 - S2 W12',
       'k', 'english', 'weekly_plans',
       '主题6：环游世界', 'published', t.id, '{"column": 40, "weekLabel": "S2 W12", "dateRange": "May 5th - May 7th (3-days)", "topic": "Antartica", "focus": "", "calendarNote": "", "readingComprehension": {"book": "Bye, Penguin!", "objectives": [], "lessonStructure": ["Fiction Text: Part 1: Predictions Part 2: Initial Reading Part 3: Making Inferences", "Visualisation", "Discussion Part 4: Reading Response Activity"]}, "guidedReading": {"wondersUnit": "Unit 9: How Things Change", "topic": "Our Natural Resources", "objectives": [], "phonics": "Long o", "phonologicalAwareness": ["RF.K.3b Associate the long and short sounds with the common spellings for the five major vowels"], "sightWords": "where, look, on", "sightWordsStandard": ["RF.K.3c Read common high-frequency words by sight"], "leveledReaders": {"approaching": "Look where it is from", "onLevel": "What''s for breakfast?", "beyond": "Nature at the craft fair"}, "preDecodableReader": "How Things Change"}, "languageSkills": {"skill": "Prefixes & Suffixes", "standard": ["L.K.4 Use the most frequently occurring inflections and affixes (e.g., -ed, -s, re-, un-, pre-, -ful, -less) as a clue to the meaning of an unknown word."]}, "guidedWriting": {"unit": "", "standard": [], "learningSequence": []}, "math": {"unit": "K Unit 5: Measurement & Data", "topic": "Length and Height: Tall and Short, Long and Short", "standard": ["KMD.A1 - Describe measurable attributes of objects, such as length or weight. Describe several measurable attributes of a single object. - KMD.A2 - Directly compare two objects with a measurable attribute in common, to see with object has \"more of\"", "\"less of\" the attribute, and describe the difference. - K.MD.B.3 Classify objects into given categories; count the numbers of objects in each category and sort the categories by count."], "sequence": []}, "assessment": "", "assessmentDetail": []}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'k' AND r.subject = 'english'
      AND r.folder_type = 'weekly_plans'
      AND COALESCE(r.theme, '') = '主题6：环游世界'
      AND r.title = '主题6：环游世界 - S2 W12'
  );

INSERT INTO resources (title, title_en, program, subject, folder_type, theme, status, uploader_id, description, version)
SELECT '主题6：环游世界 - S2 W13', '主题6：环游世界 - S2 W13',
       'k', 'english', 'weekly_plans',
       '主题6：环游世界', 'published', t.id, '{"column": 41, "weekLabel": "S2 W13", "dateRange": "May 10th - May 14th", "topic": "North America - USA", "focus": "", "calendarNote": "", "readingComprehension": {"book": "", "objectives": [], "lessonStructure": ["Fiction Text: Part 1: Predictions Part 2: Initial Reading Part 3: Making Inferences", "Visualisation", "Discussion Part 4: Reading Response Activity"]}, "guidedReading": {"wondersUnit": "Unit 10: Thinking Outside the Box", "topic": "Problem Solvers", "objectives": [], "phonics": "Long u /ue/ /oo", "phonologicalAwareness": ["RF.K.3b Associate the long and short sounds with the common spellings for the five major vowels"], "sightWords": "who, good, our", "sightWordsStandard": ["RF.K.3c Read common high-frequency words by sight"], "leveledReaders": {"approaching": "Animal Band", "onLevel": "We want honey", "beyond": "A good idea"}, "preDecodableReader": "Thinking Outside the Box"}, "languageSkills": {"skill": "Prefixes & Suffixes", "standard": ["L.K.4 Use the most frequently occurring inflections and affixes (e.g., -ed, -s, re-, un-, pre-, -ful, -less) as a clue to the meaning of an unknown word."]}, "guidedWriting": {"unit": "", "standard": [], "learningSequence": []}, "math": {"unit": "K Unit 5: Measurement & Data", "topic": "Length and Height: Tall and Short, Long and Short", "standard": ["KMD.A1 - Describe measurable attributes of objects, such as length or weight. Describe several measurable attributes of a single object. - KMD.A2 - Directly compare two objects with a measurable attribute in common, to see with object has \"more of\"", "\"less of\" the attribute, and describe the difference. - K.MD.B.3 Classify objects into given categories; count the numbers of objects in each category and sort the categories by count."], "sequence": []}, "assessment": "", "assessmentDetail": []}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'k' AND r.subject = 'english'
      AND r.folder_type = 'weekly_plans'
      AND COALESCE(r.theme, '') = '主题6：环游世界'
      AND r.title = '主题6：环游世界 - S2 W13'
  );

INSERT INTO resources (title, title_en, program, subject, folder_type, theme, status, uploader_id, description, version)
SELECT '主题6：环游世界 - S2 W14', '主题6：环游世界 - S2 W14',
       'k', 'english', 'weekly_plans',
       '主题6：环游世界', 'published', t.id, '{"column": 42, "weekLabel": "S2 W14", "dateRange": "May 17th - May 21st", "topic": "Asia - India", "focus": "", "calendarNote": "May 21st - Xiao Man Poetry Conference", "readingComprehension": {"book": "Same, Same, but Different", "objectives": [], "lessonStructure": ["Non-Fiction Text: Part 1: KWL (Know, Want, Learn) Part 2: Intial Reading Part 3: Making Self-Connections", "Discussion Part 4: Reading Response", "L-Learn Activity"]}, "guidedReading": {"wondersUnit": "Unit 10: Thinking Outside the Box", "topic": "Sort it Out", "objectives": [], "phonics": "Long e", "phonologicalAwareness": ["RF.K.3b Associate the long and short sounds with the common spellings for the five major vowels"], "sightWords": "come, does, out", "sightWordsStandard": ["RF.K.3c Read common high-frequency words by sight"], "leveledReaders": {"approaching": "My box", "onLevel": "Let''s make a band", "beyond": "Going camping"}, "preDecodableReader": "Thinking Outside the Box"}, "languageSkills": {"skill": "Compound Words", "standard": ["L.K.5: With guidance and support from adults, explore word relationships and nuances in word meanings."]}, "guidedWriting": {"unit": "", "standard": [], "learningSequence": []}, "math": {"unit": "K Unit 5: Measurement & Data", "topic": "Non-standard measurement length and weight", "standard": ["KMD.A1 - Describe measurable attributes of objects, such as length or weight. Describe several measurable attributes of a single object. - KMD.A2 - Directly compare two objects with a measurable attribute in common, to see with object has \"more of\"", "\"less of\" the attribute, and describe the difference. - K.MD.B.3 Classify objects into given categories; count the numbers of objects in each category and sort the categories by count."], "sequence": []}, "assessment": "", "assessmentDetail": []}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'k' AND r.subject = 'english'
      AND r.folder_type = 'weekly_plans'
      AND COALESCE(r.theme, '') = '主题6：环游世界'
      AND r.title = '主题6：环游世界 - S2 W14'
  );

INSERT INTO resources (title, title_en, program, subject, folder_type, theme, status, uploader_id, description, version)
SELECT '主题6：环游世界 - S2 W15', '主题6：环游世界 - S2 W15',
       'k', 'english', 'weekly_plans',
       '主题6：环游世界', 'published', t.id, '{"column": 43, "weekLabel": "S2 W15", "dateRange": "May 24th - May 28th", "topic": "Oceania - New Zealand", "focus": "", "calendarNote": "", "readingComprehension": {"book": "How Maui Slowed the Sun", "objectives": [], "lessonStructure": ["Non-Fiction Text: Part 1: KWL (Know, Want, Learn) Part 2: Intial Reading Part 3: Making Self-Connections", "Discussion Part 4: Reading Response", "L-Learn Activity"]}, "guidedReading": {"wondersUnit": "Unit 10: Thinking Outside the Box", "topic": "Protect Our Earth", "objectives": [], "phonics": "Review", "phonologicalAwareness": ["RF.K.3b Associate the long and short sounds with the common spellings for the five major vowels"], "sightWords": "white, will, yes", "sightWordsStandard": ["RF.K.3c Read common high-frequency words by sight"], "leveledReaders": {"approaching": "Help clean up", "onLevel": "Let''s save Earth", "beyond": "Babysitters for seals"}, "preDecodableReader": "Thinking Outside the Box"}, "languageSkills": {"skill": "Compound Words", "standard": ["L.K.5: With guidance and support from adults, explore word relationships and nuances in word meanings."]}, "guidedWriting": {"unit": "", "standard": [], "learningSequence": []}, "math": {"unit": "K Unit 5: Measurement & Data", "topic": "Non-standard measurement length and weight", "standard": ["KMD.A1 - Describe measurable attributes of objects, such as length or weight. Describe several measurable attributes of a single object. - KMD.A2 - Directly compare two objects with a measurable attribute in common, to see with object has \"more of\"", "\"less of\" the attribute, and describe the difference. - K.MD.B.3 Classify objects into given categories; count the numbers of objects in each category and sort the categories by count."], "sequence": []}, "assessment": "", "assessmentDetail": []}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'k' AND r.subject = 'english'
      AND r.folder_type = 'weekly_plans'
      AND COALESCE(r.theme, '') = '主题6：环游世界'
      AND r.title = '主题6：环游世界 - S2 W15'
  );

INSERT INTO resources (title, title_en, program, subject, folder_type, theme, status, uploader_id, description, version)
SELECT '主题6：环游世界 - S2 W16', '主题6：环游世界 - S2 W16',
       'k', 'english', 'weekly_plans',
       '主题6：环游世界', 'published', t.id, '{"column": 44, "weekLabel": "S2 W16", "dateRange": "May 31st - June 4th", "topic": "Europe - Germany", "focus": "", "calendarNote": "June 1st - Children''s Day Event", "readingComprehension": {"book": "", "objectives": [], "lessonStructure": ["Non-Fiction Text: Part 1: KWL (Know, Want, Learn) Part 2: Intial Reading Part 3: Making Self-Connections", "Discussion Part 4: Reading Response", "L-Learn Activity"]}, "guidedReading": {"wondersUnit": "", "topic": "", "objectives": [], "phonics": "", "phonologicalAwareness": [], "sightWords": "", "sightWordsStandard": [], "leveledReaders": {"approaching": "", "onLevel": "", "beyond": ""}, "preDecodableReader": ""}, "languageSkills": {"skill": "Compound Words", "standard": ["L.K.5: With guidance and support from adults, explore word relationships and nuances in word meanings."]}, "guidedWriting": {"unit": "", "standard": [], "learningSequence": []}, "math": {"unit": "K Unit 5: Measurement & Data", "topic": "Data and Picture Graphs", "standard": ["KMD.A1 - Describe measurable attributes of objects, such as length or weight. Describe several measurable attributes of a single object. - KMD.A2 - Directly compare two objects with a measurable attribute in common, to see with object has \"more of\"", "\"less of\" the attribute, and describe the difference. - K.MD.B.3 Classify objects into given categories; count the numbers of objects in each category and sort the categories by count."], "sequence": []}, "assessment": "Summative Assessment", "assessmentDetail": ["Test 1: Letter Sounds ESGi Test 2: Letter Names ESGi"]}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'k' AND r.subject = 'english'
      AND r.folder_type = 'weekly_plans'
      AND COALESCE(r.theme, '') = '主题6：环游世界'
      AND r.title = '主题6：环游世界 - S2 W16'
  );

INSERT INTO resources (title, title_en, program, subject, folder_type, theme, status, uploader_id, description, version)
SELECT '主题6：环游世界 - Unit Summary', '主题6：环游世界 - Unit Summary',
       'k', 'english', 'weekly_plans',
       '主题6：环游世界', 'published', t.id, '{"column": 45, "weekLabel": "Unit Summary", "dateRange": "June 7th - June 11th", "topic": "Unit Summary", "focus": "", "calendarNote": "", "readingComprehension": {"book": "", "objectives": [], "lessonStructure": []}, "guidedReading": {"wondersUnit": "", "topic": "", "objectives": [], "phonics": "", "phonologicalAwareness": [], "sightWords": "", "sightWordsStandard": [], "leveledReaders": {"approaching": "", "onLevel": "", "beyond": ""}, "preDecodableReader": ""}, "languageSkills": {"skill": "", "standard": []}, "guidedWriting": {"unit": "", "standard": [], "learningSequence": []}, "math": {"unit": "", "topic": "", "standard": [], "sequence": []}, "assessment": "Summative Assessment", "assessmentDetail": ["ESGi One-to-One using the 94 Sight Words covered so far"]}', 1
FROM teachers t
WHERE t.wecom_user_id = 'system_initializer'
  AND NOT EXISTS (
    SELECT 1 FROM resources r
    WHERE r.program = 'k' AND r.subject = 'english'
      AND r.folder_type = 'weekly_plans'
      AND COALESCE(r.theme, '') = '主题6：环游世界'
      AND r.title = '主题6：环游世界 - Unit Summary'
  );


-- K 英文周计划条目总数：38


COMMIT;

-- ============================================================
-- Seed 数据完成
-- 计数验证：
--   Pre-K 美德主题: 10
--   Pre-K 蒙特梭利英文周: 42 (39 teaching + 3 holiday)
--   Pre-K 蒙特梭利非英文工作项: 245
--     - 日常生活: 79
--     - 感官: 32
--     - 数学: 36
--     - 文化: 98
--   K 英文 Theme: 6
--   K 英文周条目: 38
-- ============================================================
