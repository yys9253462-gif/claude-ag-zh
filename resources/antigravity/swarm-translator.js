// Antigravity Chinese Localization Engine - Swarm Board
(() => {
  const SWARM_ZH_VERSION = 100;
  if (window.__antigravitySwarmZhVersion === SWARM_ZH_VERSION && window.__antigravitySwarmZhObserver) {
    return;
  }
  if (window.__antigravitySwarmZhObserver) {
    try { window.__antigravitySwarmZhObserver.disconnect(); } catch {}
    window.__antigravitySwarmZhObserver = null;
  }
  window.__antigravitySwarmZhVersion = SWARM_ZH_VERSION;

  // 静态精确词典（涵盖蜂群面板全部 5 个标签页、工具栏、筛选器、蜂巢图、回放控件、弹窗与提示）
  const EXACT_MAP = new Map(Object.entries({
    // 页面标题与头部状态
    'Swarm': '蜂群',
    'Untitled swarm': '未命名蜂群',
    'Live': '实时',
    'Reconnecting': '重连中',
    'Updates automatically': '自动更新',
    'Lost contact with the swarm sidecar; retrying': '与蜂群边车服务断开连接，正在重试',
    "Looking for this conversation's swarm…": '正在查找当前对话的蜂群…',
    "Looking for this conversation's swarm...": '正在查找当前对话的蜂群…',
    'Swarm views': '蜂群视图',

    // 顶部五个主标签页
    'Overview': '概览',
    'Board': '公告板',
    'Members': '成员',
    'Graph': '关系图',
    'Raw': '原始数据',

    // 概览页与叙事者状态栏
    'System alerts': '系统告警',
    'overview · from the narrator’s notes': '概览 · 来自叙事者记录',
    "overview · from the narrator's notes": '概览 · 来自叙事者记录',
    'narrator’s page · AI-generated': '叙事者页面 · AI 生成',
    "narrator's page · AI-generated": '叙事者页面 · AI 生成',
    'Narrator’s page': '叙事者页面',
    "Narrator's page": '叙事者页面',
    'Retry narrator’s page': '重试叙事者页面',
    "Retry narrator's page": '重试叙事者页面',
    'Narrator view (AI-generated)': '叙事者视图（AI 生成）',
    'Want this view different? Tell the coordinator.': '想要调整此视图？直接告诉协调者。',
    'Open coordinator chat': '打开协调者对话',
    'No narrator in this swarm. Ask the coordinator to add one.': '此蜂群暂无叙事者，可让协调者添加一个。',
    "The narrator's view.json is over 64 KB, so it isn't shown.": '叙事者的 view.json 超过 64 KB，已跳过显示。',
    "The narrator's view.json isn't valid JSON yet.": '叙事者的 view.json 暂非有效 JSON。',
    "The narrator hasn't published an overview yet.": '叙事者尚未发布概览。',
    'updating': '更新中',
    'watching': '监听中',
    'stopped': '已停止',
    'stale': '待刷新',
    'paused: quota': '已暂停：配额不足',
    'paused: error': '已暂停：出错',
    'The narrator is updating the overview': '叙事者正在更新概览',
    'The narrator is waiting for new board posts': '叙事者正在等待新的公告消息',
    'The narrator was killed; the overview no longer updates': '叙事者已终止，概览不再更新',
    'system:': '系统：',
    'Open': '打开',
    'view.html is over 64 KB': 'view.html 超过 64 KB',
    'no view.html yet': '尚无 view.html',
    'loading the narrator view': '正在加载叙事者视图',

    // 概览/成员/蜂巢卡片通用 UI（来自 hive.js COPY_UI 与各卡片）
    'The team': '团队成员',
    'Coordinator': '协调者',
    'Coordinator · Working': '协调者 · 工作中',
    'Blocked': '已阻塞',
    'Running': '进行中',
    'Planned next': '后续计划',
    'Done': '已完成',
    'Goal': '目标',
    'Threads': '工作线程',
    'Now': '当前',
    'Progress': '进度',
    'Compare with now': '与当前对比',
    'Hide compare': '收起对比',
    'Open full timeline': '打开完整时间线',
    'Compare then and now': '对比历史与当前画面',
    'Scrub through progress': '拖动浏览进度帧',
    'Frames': '进度帧列表',
    'Nothing blocked': '暂无阻塞项',
    'Needs you': '等待您确认',
    'Waiting on @coordinator': '等待 @coordinator',
    'Stuck': '已卡住',
    'Error': '出错',
    'Nothing waiting': '暂无等待项',
    'Nothing stuck': '暂无卡住项',
    'Nothing needs you': '暂无待您处理项',
    'Nothing running': '暂无运行中任务',
    'Nothing planned': '暂无待办计划',
    'In review': '审核中',
    'In progress': '进行中',
    'Moving': '推进中',
    'Not started': '未开始',
    'Other': '其他',
    'Tasks': '任务',
    'Task': '任务',
    'No tasks completed yet.': '尚未有已完成的任务。',
    'Swarm stalled — no agents working': '蜂群已停滞 —— 当前无智能体在工作',
    'All workers': '全部执行成员',
    'All': '全部',
    'Filter by worker': '按成员筛选',
    'The coordinator asked. Answer it in its chat.': '协调者向您提出了问题，请在协调者对话中回复。',

    // 新手启动引导三步卡片
    'Your swarm is starting': '您的蜂群正在启动',
    'One goal': '一个目标',
    'The coordinator splits it into tasks.': '协调者将目标拆分为若干任务。',
    'Many workers': '多位执行成员',
    'Each takes a task, and they run in parallel.': '每位成员各自认领任务并并行推进。',
    'One board': '一块公告板',
    'Updates land here. You step in only when asked.': '进度在此汇总，仅在需要确认时才打扰您。',
    'Waiting for the first update': '正在等待第一条进展更新',

    // 成员页与状态词
    'Search members': '搜索成员',
    'Active': '活跃',
    'Working': '工作中',
    'Waiting': '等待中',
    'Killed': '已终止',
    'Retired': '已结束',
    'Resting': '空闲中',
    'Standing by': '待命中',
    'Team': '团队',
    'No posts yet': '暂无公告',
    'all channels': '全部频道',
    'Active: mid-turn (thinking, running a tool, or waiting on the model)': '活跃：正在执行本轮（思考、调用工具或等待模型响应）',
    'Waiting: turn ended, asleep on the board until a post wakes it': '等待中：本轮已结束，在公告板休眠待命，收到新消息后唤醒',
    'Killed: removed from the swarm': '已终止：已从当前蜂群移除',
    'seen just now': '刚刚活跃',

    // 后端工具实时活动标签（main.mjs BOARD_ACTIVITY）
    'Waiting for posts': '等待新消息',
    'Reading the board': '正在查看公告板',
    'Posting to the board': '正在发送公告',

    // 公告板工具栏、筛选器与空状态
    'Search': '搜索',
    'Search posts': '搜索公告',
    'Filters': '筛选',
    'Filters (active)': '筛选（已启用）',
    'Channels': '频道',
    'From anyone': '任意发送者',
    'To anyone': '任意接收者',
    'To no one': '无指定接收者',
    'To @all': '发给 @all（全员）',
    'All channels': '全部频道',
    'Posts in every channel': '所有频道中的公告',
    'main: the whole swarm reads it': 'main：蜂群全体成员均可阅读',
    'Filter by poster': '按发送者筛选',
    'Show posts by one member': '仅查看某位成员发布的公告',
    'Filter by recipient': '按接收者筛选',
    'Show posts that call on one member': '仅查看提及某位成员的公告',
    'Filter by channel': '按频道筛选',
    'Show posts in one channel': '仅查看单个频道中的公告',
    'Keep the newest post in view': '始终滚动跟随最新公告',
    'Follow': '自动跟随',
    "Show or hide each member's posts": '显示或隐藏各成员发布的公告',
    'Latest': '最新消息',
    'New': '未读',
    'Show more': '展开更多',
    'Show less': '收起',
    'Not on the roster': '不在名册中',
    'not on roster': '不在名册',
    'Searching earlier posts…': '正在搜索更早的公告…',
    'No loaded posts match': '已加载公告中无匹配项',
    'Retry loading earlier posts': '重试加载更早的公告',
    'No posts match': '没有匹配的公告',
    'Try a different search or member filter.': '请尝试更换搜索词或调整成员筛选条件。',
    'Clear filters': '清除筛选',
    'Posts to the swarm board will appear here as members talk.': '成员开始交流后，公告板消息会实时显示在这里。',

    // 关系图、蜂巢图、回放控件与动图导出
    'Replay': '回放控制',
    'Jump to start': '跳到开头',
    'Previous post (←)': '上一条公告 (←)',
    'Previous post': '上一条公告',
    'Play / pause replay (space)': '播放 / 暂停回放（空格）',
    'Play replay': '播放回放',
    'Pause replay': '暂停回放',
    'Next post (→)': '下一条公告 (→)',
    'Next post': '下一条公告',
    'Replay position': '回放进度',
    'Scrub through board posts': '拖动回看公告板历史进度',
    'Show everything and follow live': '显示全部内容并跟随实时更新',
    'Graph view': '关系图视图',
    'Hive': '蜂巢图',
    'Mentions': '提及图',
    'Threads as cells, with each worker where it works': '以蜂巢单元展示工作线程及各成员位置',
    'Who @mentions whom': '成员之间的 @提及 关系',
    'Hide killed and inactive members from the graph': '在图中隐藏已终止和非活跃成员',
    'Hide inactive': '隐藏非活跃',
    'Draw @all as an edge to every member': '将 @all 展开绘制为指向全体成员的连线',
    'Expand @all': '展开 @all',
    'Replay pacing': '回放节奏',
    'Even pacing': '均匀节奏',
    'Real-time gaps': '真实时间间隔',
    'Replay speed': '回放倍速',
    'Export graph replay as an animated GIF': '将关系图回放导出为 GIF 动图',
    'Export GIF': '导出 GIF',
    '@mention, width = count': '@提及（线宽表示次数）',
    'via @all': '通过 @all 广播',
    'posted with no mention': '未提及他人的公告',
    '@all posts, drawn by Expand @all': '@all 广播消息（开启“展开 @all”后连线）',
    'Zoom': '缩放',
    'Zoom out': '缩小',
    'Zoom in': '放大',
    'Fit the whole swarm': '自适应缩放整个蜂群',
    'Where each worker is, by thread': '按工作线程展示各成员分布',
    'Tasks done': '已完成任务',
    'Message just sent': '刚发送的消息',
    'Waiting on': '正在等待',
    'No one is on this thread yet.': '该线程暂未分配成员。',
    'Previous': '上一张',
    'Next': '下一张',
    'Close': '关闭',
    'Close preview': '关闭预览',
    'Exported swarm graph replay': '已导出的蜂群关系图回放',
    'Right-click image to save, or open in a new tab.': '右键点击图片即可保存，或在新标签页中打开。',
    'Open in new tab': '在新标签页打开',
    'Could not download GIF from embedded pane.': '无法在内置面板直接下载 GIF，请右键保存图片。',
    'Could not export GIF.': '导出 GIF 失败。',

    // 原始数据标签页
    'File': '文件',
    'Copy to clipboard': '复制到剪贴板',
    'Copy': '复制',
    'Copied': '已复制',
    'Copy failed': '复制失败',
    'Loading…': '正在加载…',

    // 无蜂群空状态与轻提示
    'No swarm in this conversation': '当前对话暂无蜂群',
    'Watching for a swarm': '正在监听蜂群启动',
    'Could not load earlier posts': '加载更早公告失败',
    "That link isn't allowed here.": '此处不允许打开该链接。',
    'Opening files needs the app.': '需要在桌面应用中打开本地文件。',
    'Click a link in the view to open it.': '请直接点击视图中的链接打开。',
  }));

  // 动态模板正则（按高频顺序匹配）
  const PATTERNS = [
    { re: /^(\d+)\s+of\s+(\d+)\s+tasks?\s+done$/i, rep: '已完成 $1 / $2 项任务' },
    { re: /^(\d+)\s+of\s+(\d+)\s+done$/i, rep: '已完成 $1 / $2' },
    { re: /^Waiting on @(.+)$/, rep: '等待 @$1' },
    { re: /^Waiting on (\d+)$/, rep: '等待 $1 位成员' },
    { re: /^Working for @(.+)$/, rep: '正在为 @$1 工作' },
    { re: /^(\d+)\s+waiting on @(.+)$/i, rep: '$1 项等待 @$2' },
    { re: /^(\d+)\s+needs?\s+you$/i, rep: '$1 项待您确认' },
    { re: /^(\d+)\s+in\s+review$/i, rep: '$1 项审核中' },
    { re: /^(\d+)\s+threads?\s+open$/i, rep: '$1 个活跃线程' },
    { re: /^(\d+)\s+active$/i, rep: '$1 项活跃' },
    { re: /^(\d+)\s+stuck$/i, rep: '$1 项卡住' },
    { re: /^(\d+)\s+working$/i, rep: '$1 项工作中' },
    { re: /^(\d+)\s+waiting$/i, rep: '$1 项等待中' },
    { re: /^(\d+)\s+done$/i, rep: '$1 项已完成' },
    { re: /^(\d+)\s+threads?$/i, rep: '$1 个线程' },
    { re: /^(\d+)\s+bees?$/i, rep: '$1 只工蜂' },
    { re: /^\+(\d+)\s+more$/i, rep: '展开其余 $1 项' },
    { re: /^Up next\s*·\s*(\d+)$/, rep: '接下来 · $1' },
    { re: /^From (.+)$/, rep: '来自 $1' },
    { re: /^To (.+)$/, rep: '发给 $1' },
    { re: /^#(.+)\s+\(archived\)$/, rep: '#$1（已归档）' },
    { re: /^@(\S+)\s+ran out of quota$/, rep: '@$1 配额已耗尽' },
    { re: /^@(\S+)\s+looks stuck$/, rep: '@$1 似乎卡住了' },
    { re: /^@(\S+)\s+hit an error$/, rep: '@$1 遇到错误' },
    { re: /^(\S+):\s*last step failed\s*\(quota\)$/, rep: '$1：上一步执行失败（配额不足）' },
    { re: /^(\S+):\s*last step failed\s*\(error\)$/, rep: '$1：上一步执行失败（出错）' },
    { re: /^last seen (\d+)m ago$/i, rep: '$1 分钟前活跃' },
    { re: /^last seen (\d+)h ago$/i, rep: '$1 小时前活跃' },
    { re: /^last seen (\d+)d ago$/i, rep: '$1 天前活跃' },
    { re: /^Loading earlier posts…\s*\((\d+) older\)$/, rep: '正在加载更早的公告…（还有 $1 条）' },
    { re: /^Retry loading (\d+) earlier posts?$/, rep: '重试加载 $1 条更早的公告' },
    { re: /^Show (\d+) earlier posts?\s*\((\d+) older\)$/, rep: '显示更早的 $1 条公告（还有 $2 条）' },
    { re: /^Loading (\d+) earlier posts?\.$/, rep: '正在加载 $1 条更早的公告。' },
    { re: /^(\d+) earlier posts? could not be loaded\.$/, rep: '有 $1 条更早的公告未能加载。' },
    { re: /^Go to #(\d+)\s+\((.+)\)$/, rep: '跳转到 #$1（$2）' },
    { re: /^Go to #(\d+)\s+on the Board$/, rep: '前往公告板查看 #$1' },
    { re: /^Go to #(\d+)$/, rep: '跳转到 #$1' },
    { re: /^Open @(.+)$/, rep: '打开 @$1' },
    { re: /^Open (.+)$/, rep: '打开 $1' },
    { re: /^Exporting (\d+)%$/, rep: '正在导出 $1%' },
    { re: /^Exported (.+?)\s+\((.+)\)$/, rep: '已导出 $1（$2）' },
    { re: /^GIF ready \((.+)\) — right-click image to save\.$/, rep: 'GIF 已就绪（$1）—— 右键图片即可保存。' },
    { re: /^Download (.+)$/, rep: '下载 $1' },
    { re: /^Post #(\d+) was not found$/, rep: '未找到第 #$1 条公告' },
    { re: /^Posted in #(.+); click to show only #(.+)$/, rep: '发布于 #$1；点击仅查看 #$2' },
    { re: /^Everyone in #(.+)$/, rep: '#$1 频道全体成员' },
    { re: /^#(.+) is archived: this addresses nobody$/, rep: '#$1 已归档：此提及不会通知任何人' },
    { re: /^Runs on (.+)$/, rep: '运行于 $1' },
    { re: /^(.+) runs on (.+); open it there\.$/, rep: '$1 运行于 $2；请在对应机器上打开。' },
    { re: /^Opening (.+)'s conversation needs the app\.$/, rep: '需要在桌面应用中打开 $1 的对话。' },
    { re: /^over (.+)$/, rep: '跨度 $1' },
    { re: /^of (\d+)$/, rep: '/ 共 $1 条' },
    { re: /^read #(\d+)\s*·\s*updated (\d+)s ago$/i, rep: '已读至 #$1 · $2 秒前更新' },
    { re: /^read #(\d+)\s*·\s*updated (\d+)m ago$/i, rep: '已读至 #$1 · $2 分钟前更新' },
    { re: /^read #(\d+)\s*·\s*updated (\d+)h ago$/i, rep: '已读至 #$1 · $2 小时前更新' },
    { re: /^read #(\d+)\s*·\s*updated (\d+)d ago$/i, rep: '已读至 #$1 · $2 天前更新' },
    { re: /^read #(\d+)\s*·\s*updated just now$/i, rep: '已读至 #$1 · 刚刚更新' },
    { re: /^read #(\d+)\s*·\s*updated (.+) ago$/, rep: '已读至 #$1 · $2 前更新' },
    { re: /^read #(\d+)$/, rep: '已读至 #$1' },
    { re: /^Narrator read up to #(\d+) of (\d+)$/, rep: '叙事者已读至 #$1 / 共 $2 条' },
    { re: /^(\d+) posts? since the view was updated$/, rep: '自上次视图更新以来新增了 $1 条公告' },
    { re: /^(\d+) posts?$/, rep: '$1 条公告' },
    { re: /^(\d+) frames?,\s*(.+)$/, rep: '$1 帧，$2' },
    { re: /^(\d+) frames?\s*·\s*(.+)$/, rep: '$1 帧 · $2' },
    { re: /^Latest action:\s*(.+)$/, rep: '最近操作：$1' },
    { re: /^Thinking:\s*(.+)$/, rep: '正在思考：$1' },
    { re: /^Coordinator\s*·\s*(\d+)\s+of\s+(\d+)\s+done\s*·\s*Needs you$/, rep: '协调者 · 已完成 $1 / $2 · 等待您确认' },
    { re: /^Coordinator\s*·\s*(\d+)\s+of\s+(\d+)\s+done$/, rep: '协调者 · 已完成 $1 / $2' },
    { re: /^The narrator's last step failed:\s*(.+)$/, rep: '叙事者上一步执行失败：$1' },
    { re: /^(.+?)\s*·\s*(\d+)\s+machines?$/, rep: '$1 · $2 台机器' },
    { re: /^(.+?)\s*·\s*reconnecting$/, rep: '$1 · 重连中' },
    { re: /^(.+?)\s*·\s*connecting$/, rep: '$1 · 连接中' },
    { re: /^(.+?)\s*·\s*unavailable$/, rep: '$1 · 不可用' },
    { re: /^Last change:\s*“(.+)”$/, rep: '上次调整：“$1”' },
    { re: /^overview · from the narrator's notes · (.+)$/, rep: '概览 · 来自叙事者记录 · $1' },
    { re: /^Showing the last good view\.json; the current file is over 64 KB\.$/, rep: '正在显示上一份有效的 view.json；当前文件超过 64 KB。' },
    { re: /^Showing the last good view\.json; the current file is not valid JSON\.$/, rep: '正在显示上一份有效的 view.json；当前文件不是有效 JSON。' },
    { re: /^Copied “(.+)”\. Paste it to the coordinator and say what you want changed\.$/, rep: '已复制“$1”。请粘贴给协调者并说明要调整的内容。' },
    { re: /^Tell the coordinator: “(.+)”$/, rep: '请告诉协调者：“$1”' },
  ];

  // 仅在成员实时活动行内生效的工具前缀规则（绝不污染公告正文）
  const LIVE_ACTIVITY_PATTERNS = [
    { re: /^Read (.+)$/, rep: '正在读取 $1' },
    { re: /^Write (.+)$/, rep: '正在写入 $1' },
    { re: /^Edit (.+)$/, rep: '正在编辑 $1' },
    { re: /^Search (.+)$/, rep: '正在搜索 $1' },
    { re: /^swarm (\w+)(?:\s+(.*))?$/, rep: '蜂群操作 $1 $2' },
  ];

  // 严格物理隔离：绝不翻译公告正文、原始 JSON、代码、成员代号、模型名、目标自定义内容与沙盒页面
  const SKIP_TEXT_SELECTOR = [
    '#raw', '.raw', '.msg-body', 'pre', 'code', 'script', 'style', 'input', 'textarea',
    '.o2-mauth', '.chip-name', '.o2-wchip', '.hv-nm', '.o2-sttxt', '.o2-mrole',
    '.o2-goal b', '.o2-goal p', '.o2-runt', '.o2-runsum', '.o2-runnote:not(.o2-live)',
    '.o2-donem b', '.o2-donem span', '.o2-tht b', '.o2-thg', '.o2-rcap', '.o2-tvcap',
    '.o2-askb b', '.o2-askl', '.o2-mnow:not(.o2-mact)', '.hv-rl', '.hv-cht b', '.hv-cht span',
    '.hv-rh b', '.hv-rh i', '.msg-author', '.msg-channel', '.msg-to', '.mention',
    '[data-testid="swarm-member-owner"]', '[data-testid="swarm-member-workspace"]',
    '[data-testid="swarm-member-channels"]', '#ov-frame', '[translate="no"]', '.notranslate',
  ].join(', ');

  const ATTRS = ['title', 'aria-label', 'placeholder', 'alt'];

  function norm(s) {
    return s.replace(/\s+/g, ' ').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').trim();
  }

  function translateText(raw, isLiveActivity = false) {
    if (!raw || typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    if (!trimmed || !/[A-Za-z]/.test(trimmed)) return null;

    if (EXACT_MAP.has(trimmed)) return EXACT_MAP.get(trimmed);
    const n = norm(trimmed);
    if (EXACT_MAP.has(n)) return EXACT_MAP.get(n);

    if (isLiveActivity) {
      for (let i = 0; i < LIVE_ACTIVITY_PATTERNS.length; i++) {
        const p = LIVE_ACTIVITY_PATTERNS[i];
        if (p.re.test(n)) return n.replace(p.re, p.rep).trim();
      }
    }

    for (let i = 0; i < PATTERNS.length; i++) {
      const p = PATTERNS[i];
      if (p.re.test(n)) {
        return n.replace(p.re, p.rep);
      }
    }
    return null;
  }

  function translateMultilineTip(raw) {
    if (!raw || typeof raw !== 'string' || !/[A-Za-z]/.test(raw)) return raw;
    const direct = translateText(raw);
    if (direct) return direct;
    if (!raw.includes('\n')) return raw;
    const lines = raw.split('\n');
    let changed = false;
    const out = lines.map((line) => {
      const t = translateText(line);
      if (t) {
        changed = true;
        return t;
      }
      const replaced = line
        .replace('Hidden from the board; click to show', '已从公告板隐藏，点击重新显示')
        .replace('Click to hide from the board', '点击在公告板中隐藏该成员')
        .replace('Click to open conversation', '点击打开对话')
        .replace(' (you)', '（当前会话）');
      if (replaced !== line) {
        changed = true;
        return replaced;
      }
      return line;
    });
    return changed ? out.join('\n') : raw;
  }

  function shouldSkipTextNode(node) {
    const el = node.parentElement;
    if (!el) return true;
    // 允许未命名默认标题翻成中文，但绝不碰用户自定义蜂群标题
    if (el.id === 'swarm-title') {
      return (node.nodeValue || '').trim() !== 'Untitled swarm';
    }
    // 允许任务行内的 "Waiting on @xxx" 状态徽章翻译
    if (el.classList?.contains('o2-tw')) return false;
    if (typeof el.closest === 'function') {
      // 跳过任务标题本体（保留其内部 .o2-tw）
      if (el.closest('.o2-tt') && !el.closest('.o2-tw')) return true;
      if (el.closest(SKIP_TEXT_SELECTOR)) return true;
      // SVG 内仅允许蜂巢节点标签与提示翻译，跳过图标路径
      if (el.closest('svg') && !el.closest('.hv-svg text, .hv-svg title, #graph title')) return true;
    }
    return false;
  }

  function translateEmptyBody(el) {
    if (!el || el.id !== 'empty-body' || el._zhSwarmEmptyDone) return;
    const html = el.innerHTML || '';
    if (html.includes('Swarms started in this conversation appear here automatically')) {
      el.innerHTML = '在当前对话中启动的蜂群会自动显示在这里，包含公告板、成员名册与 @提及 关系图。输入 <code>/swarm</code> 即可启动。';
      el._zhSwarmEmptyDone = true;
    } else if (html.includes('Open this pane from a conversation to see its swarm')) {
      el.innerHTML = '请从具体对话中打开此面板以查看对应的蜂群。在对话中输入 <code>/swarm</code> 启动后会自动呈现。';
      el._zhSwarmEmptyDone = true;
    }
  }

  function translateTextNode(node) {
    if (!node || node.nodeType !== 3) return;
    const raw = node.nodeValue;
    if (!raw || node._zhSwarmOrig === raw) return;
    if (shouldSkipTextNode(node)) {
      node._zhSwarmOrig = raw;
      return;
    }
    const parent = node.parentElement;
    const isLiveActivity = Boolean(parent?.closest?.('.o2-mact, .o2-live'));
    const translated = translateText(raw, isLiveActivity);
    if (translated && translated !== raw.trim()) {
      const lead = raw.match(/^\s*/)[0];
      const trail = raw.match(/\s*$/)[0];
      const next = lead + translated + trail;
      node.nodeValue = next;
      node._zhSwarmOrig = next;
    } else {
      node._zhSwarmOrig = raw;
    }
  }

  function translateElement(el) {
    if (!el || el.nodeType !== 1) return;
    if (el.id === 'empty-body') translateEmptyBody(el);
    if (el.id === 'raw' || el.id === 'ov-frame' || el.closest?.('#raw, #ov-frame, .msg-body')) return;

    for (let i = 0; i < ATTRS.length; i++) {
      const attr = ATTRS[i];
      if (!el.hasAttribute?.(attr)) continue;
      const val = el.getAttribute(attr);
      if (!val) continue;
      const key = '_zhSwarmAttr_' + attr;
      if (el[key] === val) continue;
      const next = attr === 'title' ? translateMultilineTip(val) : (translateText(val) || val);
      if (next !== val) {
        el.setAttribute(attr, next);
        el[key] = next;
      } else {
        el[key] = val;
      }
    }
  }

  function translateSubtree(root) {
    if (!root) return;
    if (root.nodeType === 3) {
      translateTextNode(root);
      return;
    }
    if (root.nodeType === 1) {
      translateElement(root);
    }
    if (!document.createTreeWalker) return;
    const walker = document.createTreeWalker(root, 1 | 4); // SHOW_ELEMENT | SHOW_TEXT
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.nodeType === 3) {
        translateTextNode(node);
      } else if (node.nodeType === 1) {
        translateElement(node);
      }
    }
  }

  const pending = [];
  const pendingSet = new Set();
  let flushScheduled = false;

  function enqueue(node) {
    if (!node || pendingSet.has(node)) return;
    pending.push(node);
    pendingSet.add(node);
    if (!flushScheduled) {
      flushScheduled = true;
      const flush = () => {
        flushScheduled = false;
        const batch = pending.splice(0, pending.length);
        for (let i = 0; i < batch.length; i++) pendingSet.delete(batch[i]);
        for (let i = 0; i < batch.length; i++) {
          try { translateSubtree(batch[i]); } catch {}
        }
      };
      // 使用微任务在浏览器渲染本帧像素前完成同步替换，杜绝 1.5s 轮询重绘闪烁
      if (typeof queueMicrotask === 'function') queueMicrotask(flush);
      else Promise.resolve().then(flush);
    }
  }

  function start() {
    if (!document.documentElement) return;
    try {
      document.documentElement.lang = 'zh-CN';
      if (document.title === 'Swarm') document.title = '蜂群';
    } catch {}
    try {
      translateSubtree(document.body || document.documentElement);
    } catch {}

    try {
      const obs = new MutationObserver((mutations) => {
        for (let i = 0; i < mutations.length; i++) {
          const m = mutations[i];
          if (m.type === 'characterData' && m.target) {
            m.target._zhSwarmOrig = undefined;
            enqueue(m.target);
          } else if (m.type === 'attributes' && m.target && m.attributeName) {
            m.target['_zhSwarmAttr_' + m.attributeName] = undefined;
            translateElement(m.target);
          } else if (m.type === 'childList') {
            if (m.target && m.target.id === 'empty-body') {
              m.target._zhSwarmEmptyDone = false;
              translateEmptyBody(m.target);
            }
            const added = m.addedNodes;
            for (let j = 0; j < added.length; j++) {
              enqueue(added[j]);
            }
          }
        }
      });
      obs.observe(document.documentElement, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: ATTRS,
      });
      window.__antigravitySwarmZhObserver = obs;
    } catch {}
  }

  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
