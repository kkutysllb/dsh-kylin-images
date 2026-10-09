/**
 * dsh-kylin-images Web Client Extension —— 「视觉模型」配置菜单。
 *
 * BUILD NOTE: 与 dsh-animations / dsh-super-ppts / dsh-skills-bundle 同款
 * HAND-MAINTAINED 形态：必须经 window.__ModuleLoader__.load({ id, factory })
 * 自注册、经 exports.apply 暴露扩展并 return module.exports；裸 ESM export
 * 不会注册，宿主会报 "bundle .../client.js loaded without registering"。
 *
 * 双座席（软探测，缺哪个跳哪个）：
 *   1. plugins.bundle.config —— QiLin 3.x 与 DSH 0.2.x 的插件详情页配置卡座席（主面）；
 *   2. settings.section      —— DSH 0.1.x 系设置壳的动态分区（兜底面）。
 *
 * 数据面走插件自挂的 fenced JSON API（/dsh-kylin-images/api）：
 * 宿主设置 RPC 不服务第三方命名空间，且凭据（API Key）必须留在插件 vault 里
 * （0600 + 全出口脱敏），所以卡片只通过自家 API 读写，不回显明文。
 */
window.__ModuleLoader__.load({
  id: 'dsh-kylin-images',
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require('react');

    var API = '/dsh-kylin-images/api';
    var STYLE_ID = 'kimg-styles';
    var SECTION_ID = 'kylin-images-vision-model';

    var zh = {
      nav: '视觉模型',
      title: '视觉模型',
      intro: '决定「用什么画、画成什么样」：通道与模型、生成默认值、全局负面词、成本与缓存。API Key 只保存在本机插件数据目录（0600），界面永远只显示脱敏串。',
      channels: '通道',
      addChannel: '新增 / 更新通道',
      label: '名称',
      kind: '类型',
      baseUrl: 'Base URL（https，本机回环可 http）',
      apiKey: 'API Key（保存后不再回显）',
      models: '模型清单（逗号分隔）',
      sizeStyle: '尺寸风格',
      save: '保存',
      saving: '保存中…',
      remove: '删除',
      test: '测试通道',
      testing: '测试中…',
      defaults: '生成默认值',
      aspectRatio: '默认宽高比',
      resolution: '默认分辨率',
      format: '默认格式',
      count: '单次张数',
      concurrency: '批量并发',
      globalNegative: '全局负面词（逗号或换行分隔）',
      budget: '确认阈值（元）',
      cache: '结果缓存',
      spend: '累计消耗',
      realRun: '探测时小额实跑（会产生费用）',
      workbench: '图像工坊',
      workbenchIntro: '知识漫画项目：逐页产物与联系表。出图请直接在会话里让模型调用 img_comic。',
      workbenchEmpty: '还没有漫画项目。在会话里说「把这段内容做成知识漫画」即可开一个。',
      refresh: '刷新',
      pages: '页',
      images: '张',
      expand: '展开',
      collapse: '收起',
      openSheet: '打开联系表',
      sheetHint: '联系表在浏览器里「打印为 PDF」即可导出 PDF。',
      empty: '还没有配置任何通道。先加一个 mock 通道即可零密钥跑通全链路。',
      loading: '加载中…',
      failed: '操作失败，请稍后重试。',
      loadFailed: '配置加载失败：请确认插件已激活后重试。',
      retry: '重试',
      noKey: '未配置',
      saved: '已保存',
      edit: '编辑',
      autoFallback: '端点被前置代理拦截时，自动回退到另一条出图路径（推荐开启）',
      editing: '正在编辑',
      keepKeyHint: 'API Key 留空表示沿用已保存的密钥。',
      cancelEdit: '取消编辑',
      kindHint: {
        'openai-images': '同步出图：POST /v1/images/generations',
        'openai-responses': 'Responses 出图：POST /v1/responses + image_generation（不少中转只放行这一条）',
        'task-images': '异步任务：提交后轮询任务状态',
        mock: '本地模拟：零密钥跑通全链路',
      },
    };
    var en = {
      nav: 'Vision model',
      title: 'Vision model',
      intro: 'Controls what draws and how it looks: channel and model, generation defaults, global negatives, cost and cache. The API key stays in this plugin\'s local data directory (0600); the UI only ever shows a masked string.',
      channels: 'Channels',
      addChannel: 'Add / update channel',
      label: 'Label',
      kind: 'Kind',
      baseUrl: 'Base URL (https; http only for loopback)',
      apiKey: 'API key (never echoed after saving)',
      models: 'Models (comma separated)',
      sizeStyle: 'Size style',
      save: 'Save',
      saving: 'Saving…',
      remove: 'Remove',
      test: 'Test channel',
      testing: 'Testing…',
      defaults: 'Generation defaults',
      aspectRatio: 'Default aspect ratio',
      resolution: 'Default resolution',
      format: 'Default format',
      count: 'Images per run',
      concurrency: 'Batch concurrency',
      globalNegative: 'Global negatives (comma or newline separated)',
      budget: 'Confirm threshold (CNY)',
      cache: 'Result cache',
      spend: 'Accumulated spend',
      realRun: 'Run one small real generation while probing (costs money)',
      workbench: 'Image studio',
      workbenchIntro: 'Knowledge-comic projects: per-page artifacts and the contact sheet. Ask the model to call img_comic in chat to render.',
      workbenchEmpty: 'No comic project yet. Say "turn this into a knowledge comic" in chat to start one.',
      refresh: 'Refresh',
      pages: 'pages',
      images: 'images',
      expand: 'Expand',
      collapse: 'Collapse',
      openSheet: 'Open contact sheet',
      sheetHint: 'Print the contact sheet to PDF from the browser.',
      empty: 'No channel configured yet. Add a mock channel to exercise the whole chain with zero keys.',
      loading: 'Loading…',
      failed: 'The operation failed, please retry shortly.',
      loadFailed: 'Failed to load settings: make sure the plugin is active, then retry.',
      retry: 'Retry',
      noKey: 'not set',
      saved: 'Saved',
      edit: 'Edit',
      autoFallback: 'Fall back to the other image endpoint when the front proxy blocks this one (recommended)',
      editing: 'Editing',
      keepKeyHint: 'Leave the API key blank to keep the stored one.',
      cancelEdit: 'Cancel edit',
      kindHint: {
        'openai-images': 'Sync images: POST /v1/images/generations',
        'openai-responses': 'Responses images: POST /v1/responses + image_generation (many relays only allow this one)',
        'task-images': 'Async task: submit, then poll task status',
        mock: 'Local mock: exercise the whole chain with zero keys',
      },
    };

    function t(key) {
      var lang = typeof navigator !== 'undefined' && navigator.language && navigator.language.toLowerCase().indexOf('zh') === 0 ? zh : en;
      return lang[key] || key;
    }

    /* ── 设置页导航字形 ────────────────────────────────────────────
     * 宿主 settings.section 契约只投影 id/order/label，导航图标由壳层统一
     * 渲染通用字形。做法（同 dsh-super-ppts 的已验证实现）：按本地化文案
     * 标记本插件的导航行，再用注入 CSS 隐藏壳层 SVG、以 currentColor mask
     * 画自定义字形；MutationObserver 跟随语言切换与弹窗重开，disposer 清标记。
     * 缺 DOM/Observer 时为空操作。
     */
    var NAV_VISION = 'data-kimg-nav-vision';
    var NAV_COMIC = 'data-kimg-nav-comic';

    // 视觉模型：图像框 + 火花（生成）——与相机/齿轮区分开
    var NAV_VISION_SVG = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Crect x='2.5' y='4.5' width='16' height='16' rx='2.5'/%3E%3Ccircle cx='7.6' cy='10.2' r='1.6'/%3E%3Cpath d='M2.5 17.6l4.1-4.1a2 2 0 0 1 2.8 0l4 4'/%3E%3Cpath d='M20 2.5v4.4M17.8 4.7h4.4'/%3E%3C/svg%3E";
    // 图像工坊：漫画分格页（上通栏 + 下两格）——与列表/网格类图标区分开
    var NAV_COMIC_SVG = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Crect x='2.5' y='2.5' width='19' height='19' rx='2.5'/%3E%3Cpath d='M2.5 11.5h19'/%3E%3Cpath d='M12 11.5v10'/%3E%3C/svg%3E";

    // 宿主不同代次把设置导航放在不同容器里：按序尝试，命中即止。
    // 已对当前宿主源码核实：设置面板为 body 门户模态（role=dialog + aria-modal=true），
    // 导航结构 <nav> > div.navList > button.navCell > svg.navIcon(首个子元素) + span.navLabel。
    var NAV_SELECTORS = [
      '[role="dialog"] nav button',
      '[aria-modal="true"] nav button',
      'nav button',
      '[role="dialog"] button',
    ];

    function navButtons() {
      for (var index = 0; index < NAV_SELECTORS.length; index += 1) {
        var found = document.querySelectorAll(NAV_SELECTORS[index]);
        if (found && found.length > 0) return found;
      }
      return [];
    }

    function registerNavIcon(label, marker) {
      if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return function () {};
      var disposed = false;
      function sync() {
        if (disposed) return;
        var current = '';
        try { current = String(label() || '').trim(); } catch (error) { current = ''; }
        var buttons = navButtons();
        for (var index = 0; index < buttons.length; index += 1) {
          var button = buttons[index];
          var matches = current.length > 0 && String(button.textContent || '').trim() === current;
          if (matches) button.setAttribute(marker, '');
          else button.removeAttribute(marker);
        }
      }
      sync();
      var observer = new MutationObserver(sync);
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      return function () {
        disposed = true;
        observer.disconnect();
        var marked = document.querySelectorAll('[' + marker + ']');
        for (var index = 0; index < marked.length; index += 1) marked[index].removeAttribute(marker);
      };
    }

    /** 两个设置页菜单各自换字形；返回组合 disposer。 */
    function registerNavIcons() {
      var disposers = [
        registerNavIcon(function () { return t('nav'); }, NAV_VISION),
        registerNavIcon(function () { return t('workbench'); }, NAV_COMIC),
      ];
      return function () {
        for (var index = 0; index < disposers.length; index += 1) {
          try { disposers[index](); } catch (error) { /* 卸载期异常忽略 */ }
        }
      };
    }

    function ensureStyles() {
      if (typeof document === 'undefined') return null;
      if (document.getElementById(STYLE_ID) !== null) return null;
      var style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = [
        '.kimg-root{display:flex;flex-direction:column;gap:18px;max-width:64em}',
        '.kimg-intro{margin:0;font-size:13px;line-height:1.7;opacity:.66}',
        '.kimg-card{border:1px solid var(--dsw-alias-border-subtle, rgba(127,127,127,.28));border-radius:var(--dsw-radius-medium, 10px);padding:14px 16px}',
        '.kimg-card h3{margin:0 0 10px;font-size:13px;font-weight:600;letter-spacing:.02em;opacity:.8}',
        '.kimg-row{display:flex;align-items:center;gap:10px;padding:6px 0;border-bottom:1px dashed var(--dsw-alias-border-subtle, rgba(127,127,127,.18))}',
        '.kimg-row:last-child{border-bottom:none}',
        '.kimg-name{font-weight:600}',
        '.kimg-meta{font-size:12px;opacity:.62}',
        '.kimg-field{display:flex;flex-direction:column;gap:4px;margin-bottom:10px}',
        '.kimg-field label{font-size:12px;opacity:.72}',
        '.kimg-field input,.kimg-field select{background:transparent;border:1px solid var(--dsw-alias-border-subtle, rgba(127,127,127,.3));border-radius:var(--dsw-radius-small, 6px);padding:6px 8px;color:inherit;font:inherit}',
        '.kimg-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px}',
        '.kimg-actions{display:flex;gap:8px;align-items:center}',
        '.kimg-actions button{border:1px solid var(--dsw-alias-border-subtle, rgba(127,127,127,.3));background:transparent;color:inherit;border-radius:var(--dsw-radius-small, 6px);padding:6px 12px;cursor:pointer;font:inherit}',
        '.kimg-actions button[disabled]{opacity:.45;cursor:default}',
        '.kimg-state{font-size:12px;opacity:.66}',
        '.kimg-state[data-kind=error]{color:var(--dsw-alias-text-danger, #d9534f);opacity:1}',
        // 设置页导航字形：隐藏壳层 SVG，用 ::before + mask 画自定义字形
        // 壳层字形可能直接是子元素，也可能被一层 span 包着：两种都隐藏
        '[' + NAV_VISION + '] > svg:first-child,'
          + '[' + NAV_VISION + '] > span:first-child > svg:first-child{display:none;}',
        '[' + NAV_VISION + ']::before{content:\'\';flex:none;width:16px;height:16px;background:currentColor;'
          + '-webkit-mask:url("' + NAV_VISION_SVG + '") center / contain no-repeat;'
          + 'mask:url("' + NAV_VISION_SVG + '") center / contain no-repeat;}',
        '[' + NAV_COMIC + '] > svg:first-child,'
          + '[' + NAV_COMIC + '] > span:first-child > svg:first-child{display:none;}',
        '[' + NAV_COMIC + ']::before{content:\'\';flex:none;width:16px;height:16px;background:currentColor;'
          + '-webkit-mask:url("' + NAV_COMIC_SVG + '") center / contain no-repeat;'
          + 'mask:url("' + NAV_COMIC_SVG + '") center / contain no-repeat;}',
      ].join('');
      document.head.appendChild(style);
      return function () { if (style.parentNode) style.parentNode.removeChild(style); };
    }

    function request(action, body) {
      var method = body === undefined ? 'GET' : 'POST';
      return fetch(API + '/' + action, {
        method: method,
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      }).then(function (response) {
        return response.json().catch(function () { return { ok: false }; });
      });
    }

    function splitList(text) {
      return String(text || '').split(/[,\n]/).map(function (part) { return part.trim(); }).filter(function (part) { return part !== ''; });
    }

    /* 通道类型的可选值与本地化说明。openai-responses 曾漏配：
     * 真机上把站点只放行的 Responses 路径直接变成「不可选」，用户被迫选了同步出图，
     * 结果一出图就是 403 HTML。类型清单必须与 src/provider/types.ts 的 CHANNEL_KINDS 对齐。 */
    var KIND_VALUES = ['openai-images', 'openai-responses', 'task-images', 'mock'];

    /** 表单初始值。id 非空表示正在编辑既有通道（保存时按 id 原地更新）。 */
    function emptyDraft() {
      return { id: '', label: '', kind: 'mock', baseUrl: '', apiKey: '', models: '', sizeStyle: 'ratio-resolution', autoFallback: true };
    }

    function kindOptions() {
      var hints = t('kindHint') || {};
      return KIND_VALUES.map(function (value) {
        var hint = hints[value];
        return { value: value, label: hint ? value + ' — ' + hint : value };
      });
    }

    function VisionModelCard() {
      var stateHook = React.useState({ status: 'loading', channels: [], settings: null, spend: null, error: null });
      var snapshot = stateHook[0];
      var setSnapshot = stateHook[1];
      var busyHook = React.useState(false);
      var busy = busyHook[0];
      var setBusy = busyHook[1];
      var noticeHook = React.useState(null);
      var notice = noticeHook[0];
      var setNotice = noticeHook[1];
      var realRunHook = React.useState(false);
      var realRun = realRunHook[0];
      var setRealRun = realRunHook[1];
      var draftHook = React.useState(emptyDraft());
      var draft = draftHook[0];
      var setDraft = draftHook[1];

      var load = React.useCallback(function () {
        request('state').then(function (payload) {
          if (!payload || payload.ok !== true) {
            setSnapshot({ status: 'error', channels: [], settings: null, spend: null, error: 'load' });
            return;
          }
          setSnapshot({ status: 'ready', channels: payload.value.channels || [], settings: payload.value.settings, spend: payload.value.spend, error: null });
        }, function () {
          setSnapshot({ status: 'error', channels: [], settings: null, spend: null, error: 'load' });
        });
      }, []);

      React.useEffect(function () { load(); }, [load]);

      function run(promise) {
        setBusy(true);
        setNotice(null);
        return promise.then(function (payload) {
          setBusy(false);
          if (!payload || payload.ok !== true) {
            setNotice({ kind: 'error', text: (payload && payload.error && payload.error.message) || t('failed') });
            return payload;
          }
          setNotice({ kind: 'ok', text: t('saved') });
          load();
          return payload;
        }, function () {
          setBusy(false);
          setNotice({ kind: 'error', text: t('failed') });
        });
      }

      if (snapshot.status === 'loading') {
        return React.createElement('p', { className: 'kimg-state' }, t('loading'));
      }
      if (snapshot.status === 'error') {
        return React.createElement('div', null,
          React.createElement('p', { className: 'kimg-state', 'data-kind': 'error' }, t('loadFailed')),
          React.createElement('div', { className: 'kimg-actions' },
            React.createElement('button', { type: 'button', onClick: load }, t('retry'))));
      }

      var settings = snapshot.settings || {};
      var spend = snapshot.spend || { total: 0, currency: 'CNY', images: 0, entries: 0 };
      var cache = snapshot.cache || null;

      function updateSetting(field, value) {
        var patch = {};
        patch[field] = value;
        run(request('settings.update', { patch: patch }));
      }

      return React.createElement('div', { className: 'kimg-root' },
        React.createElement('p', { className: 'kimg-intro' }, t('intro')),
        notice !== null ? React.createElement('p', { className: 'kimg-state', 'data-kind': notice.kind === 'error' ? 'error' : 'ok' }, notice.text) : null,

        React.createElement('div', { className: 'kimg-card' },
          React.createElement('h3', null, t('channels')),
          snapshot.channels.length === 0
            ? React.createElement('p', { className: 'kimg-state' }, t('empty'))
            : snapshot.channels.map(function (channel) {
                return React.createElement('div', { className: 'kimg-row', key: channel.id },
                  React.createElement('span', { className: 'kimg-name' }, channel.label),
                  React.createElement('span', { className: 'kimg-meta' }, channel.id + ' · ' + channel.kind + ' · key=' + (channel.apiKey || t('noKey')) + ' · ' + (channel.models || []).join(', ')),
                  React.createElement('span', { style: { flex: 1 } }),
                  React.createElement('button', {
                    type: 'button', disabled: busy,
                    onClick: function () {
                      // 不带 id 的 upsert 会新开一条（slugFrom 会避开已占用 id），
                      // 所以「改类型」必须先把既有通道读进草稿，否则用户只能删了重建 + 重输密钥。
                      setDraft({
                        id: channel.id,
                        label: channel.label,
                        kind: channel.kind,
                        baseUrl: channel.baseUrl,
                        apiKey: '',
                        models: (channel.models || []).join(', '),
                        sizeStyle: channel.sizeStyle || 'ratio-resolution',
                        autoFallback: channel.autoFallback !== false,
                      });
                      setNotice(null);
                    },
                  }, t('edit')),
                  React.createElement('button', {
                    type: 'button', disabled: busy,
                    onClick: function () {
                      setBusy(true);
                      request('channels.probe', { id: channel.id, realRun: realRun }).then(function (payload) {
                        setBusy(false);
                        var value = payload && payload.value;
                        if (value) {
                          var summary = channel.id + ': 鉴权=' + (value.auth || 'unknown') + ' · 端点=' + (value.endpointStyle || '-') + ' · 模型 ' + ((value.models || []).length) + ' 个';
                          if (value.route) summary += ' · ' + value.route.images.path + '=' + value.route.images.state + ' · ' + value.route.responses.path + '=' + value.route.responses.state;
                          if (value.realRun) summary += ' · 实跑' + (value.realRun.ok ? '成功' : '失败');
                          setNotice({ kind: payload && payload.ok ? 'ok' : 'error', text: summary + ' — ' + (value.detail || '') });
                        } else {
                          setNotice({ kind: 'error', text: t('failed') });
                        }
                      }, function () { setBusy(false); setNotice({ kind: 'error', text: t('failed') }); });
                    },
                  }, busy ? t('testing') : t('test')),
                  React.createElement('button', {
                    type: 'button', disabled: busy,
                    onClick: function () { run(request('channels.remove', { id: channel.id })); },
                  }, t('remove')));
              })),

        React.createElement('div', { className: 'kimg-card' },
          React.createElement('h3', null, t('addChannel')),
          draft.id !== ''
            ? React.createElement('p', { className: 'kimg-state' },
                t('editing') + ' ' + draft.id + ' — ' + t('keepKeyHint') + ' ',
                React.createElement('button', {
                  type: 'button', disabled: busy,
                  onClick: function () { setDraft(emptyDraft()); setNotice(null); },
                }, t('cancelEdit')))
            : null,
          React.createElement('div', { className: 'kimg-grid' },
            field('label', t('label'), draft.label, function (value) { setDraft(Object.assign({}, draft, { label: value })); }),
            select('kind', t('kind'), draft.kind, kindOptions(), function (value) { setDraft(Object.assign({}, draft, { kind: value })); }),
            field('baseUrl', t('baseUrl'), draft.baseUrl, function (value) { setDraft(Object.assign({}, draft, { baseUrl: value })); }),
            field('apiKey', t('apiKey'), draft.apiKey, function (value) { setDraft(Object.assign({}, draft, { apiKey: value })); }, 'password'),
            field('models', t('models'), draft.models, function (value) { setDraft(Object.assign({}, draft, { models: value })); }),
            select('sizeStyle', t('sizeStyle'), draft.sizeStyle, ['ratio-resolution', 'pixels', 'ignore'], function (value) { setDraft(Object.assign({}, draft, { sizeStyle: value })); }),
            checkbox('autoFallback', t('autoFallback'), draft.autoFallback, function (value) { setDraft(Object.assign({}, draft, { autoFallback: value })); })),
          React.createElement('div', { className: 'kimg-actions' },
            React.createElement('button', {
              type: 'button', disabled: busy,
              onClick: function () {
                var channel = { id: draft.id, label: draft.label, kind: draft.kind, baseUrl: draft.baseUrl, apiKey: draft.apiKey, models: splitList(draft.models), sizeStyle: draft.sizeStyle, autoFallback: draft.autoFallback === true };
                run(request('channels.upsert', { channel: channel })).then(function () {
                  // 保留类型与尺寸风格，方便连续配置多个同构通道；其余清空。
                  setDraft(Object.assign(emptyDraft(), { kind: draft.kind, sizeStyle: draft.sizeStyle }));
                });
              },
            }, busy ? t('saving') : t('save')))),

        React.createElement('div', { className: 'kimg-card' },
          React.createElement('h3', null, t('defaults')),
          React.createElement('div', { className: 'kimg-grid' },
            select('defaultAspectRatio', t('aspectRatio'), settings.defaultAspectRatio, ['3:4', '4:3', '16:9', '9:16', '1:1', '2:3', '3:2'], function (value) { updateSetting('defaultAspectRatio', value); }),
            select('defaultResolution', t('resolution'), settings.defaultResolution, ['1k', '2k', '4k'], function (value) { updateSetting('defaultResolution', value); }),
            select('defaultFormat', t('format'), settings.defaultFormat, ['png', 'jpeg', 'webp'], function (value) { updateSetting('defaultFormat', value); }),
            field('defaultCount', t('count'), String(settings.defaultCount), function (value) { updateSetting('defaultCount', Number(value)); }),
            field('concurrency', t('concurrency'), String(settings.concurrency), function (value) { updateSetting('concurrency', Number(value)); }),
            field('budgetConfirmCny', t('budget'), String(settings.budgetConfirmCny), function (value) { updateSetting('budgetConfirmCny', Number(value)); }),
            field('globalNegative', t('globalNegative'), (settings.globalNegative || []).join(', '), function (value) { updateSetting('globalNegative', splitList(value)); }),
            select('cacheEnabled', t('cache'), String(settings.cacheEnabled), ['true', 'false'], function (value) { updateSetting('cacheEnabled', value === 'true'); }))),

        React.createElement('p', { className: 'kimg-state' },
          t('spend') + ': ' + spend.total + ' ' + spend.currency + ' · ' + spend.images + ' / ' + spend.entries,
          cache === null ? null : ' · ' + t('cache') + ': ' + cache.entries + ' / ' + cache.hits,
          React.createElement('label', { style: { marginLeft: '12px' } },
            React.createElement('input', {
              type: 'checkbox',
              checked: realRun,
              onChange: function (event) { setRealRun(event.target.checked); },
            }), ' ' + t('realRun'))));
    }

    function field(name, label, value, onChange, type) {
      return React.createElement('div', { className: 'kimg-field', key: name },
        React.createElement('label', null, label),
        React.createElement('input', {
          type: type || 'text',
          value: value === undefined || value === null ? '' : value,
          onChange: function (event) { onChange(event.target.value); },
        }));
    }

    function checkbox(name, label, checked, onChange) {
      return React.createElement('div', { className: 'kimg-field', key: name },
        React.createElement('label', null,
          React.createElement('input', {
            type: 'checkbox',
            checked: checked === true,
            onChange: function (event) { onChange(event.target.checked); },
          }),
          ' ' + label));
    }

    function select(name, label, value, options, onChange) {
      return React.createElement('div', { className: 'kimg-field', key: name },
        React.createElement('label', null, label),
        React.createElement('select', {
          value: value === undefined || value === null ? '' : value,
          onChange: function (event) { onChange(event.target.value); },
        }, options.map(function (option) {
          var optionValue = (typeof option === 'object' && option !== null) ? option.value : option;
          var optionLabel = (typeof option === 'object' && option !== null) ? (option.label || option.value) : option;
          return React.createElement('option', { key: optionValue, value: optionValue }, optionLabel);
        })));
    }

    /* ── 侧边栏「图像工坊」：漫画项目与产物 ─────────────────── */

    var WORKBENCH_ID = 'kylin-images-workbench';

    function artifactUrl(relative) {
      return '/dsh-kylin-images/artifact?path=' + encodeURIComponent(relative);
    }

    function ImageWorkbenchPanel() {
      var stateHook = React.useState({ status: 'loading', projects: [], open: null, detail: null });
      var snapshot = stateHook[0];
      var setSnapshot = stateHook[1];

      var load = React.useCallback(function () {
        request('comic.list').then(function (payload) {
          if (!payload || payload.ok !== true) {
            setSnapshot({ status: 'error', projects: [], open: null, detail: null });
            return;
          }
          setSnapshot(function (current) {
            return { status: 'ready', projects: payload.value || [], open: current.open, detail: current.detail };
          });
        }, function () {
          setSnapshot({ status: 'error', projects: [], open: null, detail: null });
        });
      }, []);

      React.useEffect(function () { load(); }, [load]);

      function openProject(id) {
        if (snapshot.open === id) {
          setSnapshot(Object.assign({}, snapshot, { open: null, detail: null }));
          return;
        }
        setSnapshot(Object.assign({}, snapshot, { open: id, detail: null }));
        request('comic.status?id=' + encodeURIComponent(id)).then(function (payload) {
          if (payload && payload.ok === true) {
            setSnapshot(Object.assign({}, snapshot, { open: id, detail: payload.value }));
          }
        });
      }

      if (snapshot.status === 'loading') {
        return React.createElement('p', { className: 'kimg-state' }, t('loading'));
      }
      if (snapshot.status === 'error') {
        return React.createElement('div', null,
          React.createElement('p', { className: 'kimg-state', 'data-kind': 'error' }, t('loadFailed')),
          React.createElement('div', { className: 'kimg-actions' },
            React.createElement('button', { type: 'button', onClick: load }, t('retry'))));
      }

      return React.createElement('div', { className: 'kimg-root' },
        React.createElement('p', { className: 'kimg-intro' }, t('workbenchIntro')),
        React.createElement('div', { className: 'kimg-actions' },
          React.createElement('button', { type: 'button', onClick: load }, t('refresh'))),
        snapshot.projects.length === 0
          ? React.createElement('p', { className: 'kimg-state' }, t('workbenchEmpty'))
          : React.createElement('div', null, snapshot.projects.map(function (project) {
              var detail = snapshot.open === project.id ? snapshot.detail : null;
              var images = [];
              if (detail && detail.pages) {
                detail.pages.forEach(function (page) {
                  if (page.status === 'rendered' && page.imagePath) {
                    images.push(React.createElement('img', {
                      key: page.index,
                      src: artifactUrl('comics/' + project.id + '/' + page.imagePath),
                      alt: page.title,
                      style: { width: '48%', margin: '1%', borderRadius: '6px' },
                    }));
                  }
                });
              }
              return React.createElement('div', { key: project.id, className: 'kimg-card' },
                React.createElement('div', { className: 'kimg-row' },
                  React.createElement('span', { className: 'kimg-name' }, project.topic),
                  React.createElement('span', { className: 'kimg-meta' },
                    project.stage + ' · ' + project.rendered + '/' + project.pages + ' ' + t('pages') +
                    ' · ' + project.spend.images + ' ' + t('images')),
                  React.createElement('span', { style: { flex: 1 } }),
                  React.createElement('button', { type: 'button', onClick: function () { openProject(project.id); } },
                    snapshot.open === project.id ? t('collapse') : t('expand'))),
                snapshot.open === project.id ? React.createElement('div', null,
                  React.createElement('div', { style: { display: 'flex', flexWrap: 'wrap' } }, images),
                  React.createElement('div', { className: 'kimg-actions' },
                    React.createElement('button', {
                      type: 'button',
                      onClick: function () {
                        if (typeof window !== 'undefined' && window.open) {
                          window.open(artifactUrl('comics/' + project.id + '/contact-sheet.html'), '_blank');
                        }
                      },
                    }, t('openSheet'))),
                  React.createElement('p', { className: 'kimg-meta' }, t('sheetHint'))) : null);
            })));
    }

    var inject = ['slots'];

    function apply(ctx) {
      var removeStyles = ensureStyles();
      if (removeStyles !== null && ctx && typeof ctx.effect === 'function') {
        ctx.effect(function () { return removeStyles; }, 'dsh-kylin-images: settings styles');
      }
      // 设置页导航字形不依赖 slots（只需 DOM + effect），因此放在 slots 守卫之前：
      // 宿主缺 slots 时字形仍应生效，否则会退回壳层的通用字形。
      if (ctx && typeof ctx.effect === 'function') {
        ctx.effect(registerNavIcons, 'dsh-kylin-images: settings nav icons');
      }

      if (!ctx || !ctx.slots || typeof ctx.slots.inject !== 'function') return;

      function bindSeat(seat, options, component, label) {
        try {
          ctx.slots.inject(seat, function () {
            return ctx.slots.register(Object.assign({ name: seat, locale: 'kylinImages' }, options), component);
          });
        } catch (error) {
          console.warn('[dsh-kylin-images] 宿主缺少插槽 ' + seat + '，已跳过 ' + label + ':', error && error.message);
        }
      }

      // 主面：**设置页面**的「视觉模型」菜单（本插件的配置入口就在这里）。
      // 不占用 workspace 侧边栏 —— 配置属于设置页，不属于工作区侧栏。
      bindSeat('settings.section', {
        id: SECTION_ID,
        order: 20,
        label: function () { return t('nav'); },
      }, VisionModelCard, 'settings.section(视觉模型)');

      // 同一设置页里的第二个菜单：知识漫画项目与产物。
      bindSeat('settings.section', {
        id: WORKBENCH_ID,
        order: 21,
        label: function () { return t('workbench'); },
      }, ImageWorkbenchPanel, 'settings.section(图像工坊)');

      // 插件详情页的配置卡（插件管理器页面），与设置页共用同一份表单。
      bindSeat('plugins.bundle.config', { key: 'dsh-kylin-images' }, VisionModelCard, 'plugins.bundle.config');
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
