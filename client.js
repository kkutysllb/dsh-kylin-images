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
      empty: '还没有配置任何通道。先加一个 mock 通道即可零密钥跑通全链路。',
      loading: '加载中…',
      failed: '操作失败，请稍后重试。',
      loadFailed: '配置加载失败：请确认插件已激活后重试。',
      retry: '重试',
      noKey: '未配置',
      saved: '已保存',
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
      empty: 'No channel configured yet. Add a mock channel to exercise the whole chain with zero keys.',
      loading: 'Loading…',
      failed: 'The operation failed, please retry shortly.',
      loadFailed: 'Failed to load settings: make sure the plugin is active, then retry.',
      retry: 'Retry',
      noKey: 'not set',
      saved: 'Saved',
    };

    function t(key) {
      var lang = typeof navigator !== 'undefined' && navigator.language && navigator.language.toLowerCase().indexOf('zh') === 0 ? zh : en;
      return lang[key] || key;
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
      var draftHook = React.useState({ label: '', kind: 'mock', baseUrl: '', apiKey: '', models: '', sizeStyle: 'ratio-resolution' });
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
                      setBusy(true);
                      request('channels.probe', { id: channel.id, realRun: realRun }).then(function (payload) {
                        setBusy(false);
                        var value = payload && payload.value;
                        if (value) {
                          var summary = channel.id + ': 鉴权=' + (value.auth || 'unknown') + ' · 端点=' + (value.endpointStyle || '-') + ' · 模型 ' + ((value.models || []).length) + ' 个';
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
          React.createElement('div', { className: 'kimg-grid' },
            field('label', t('label'), draft.label, function (value) { setDraft(Object.assign({}, draft, { label: value })); }),
            select('kind', t('kind'), draft.kind, ['mock', 'openai-images', 'task-images'], function (value) { setDraft(Object.assign({}, draft, { kind: value })); }),
            field('baseUrl', t('baseUrl'), draft.baseUrl, function (value) { setDraft(Object.assign({}, draft, { baseUrl: value })); }),
            field('apiKey', t('apiKey'), draft.apiKey, function (value) { setDraft(Object.assign({}, draft, { apiKey: value })); }, 'password'),
            field('models', t('models'), draft.models, function (value) { setDraft(Object.assign({}, draft, { models: value })); }),
            select('sizeStyle', t('sizeStyle'), draft.sizeStyle, ['ratio-resolution', 'pixels', 'ignore'], function (value) { setDraft(Object.assign({}, draft, { sizeStyle: value })); })),
          React.createElement('div', { className: 'kimg-actions' },
            React.createElement('button', {
              type: 'button', disabled: busy,
              onClick: function () {
                var channel = { label: draft.label, kind: draft.kind, baseUrl: draft.baseUrl, apiKey: draft.apiKey, models: splitList(draft.models), sizeStyle: draft.sizeStyle };
                run(request('channels.upsert', { channel: channel })).then(function () {
                  setDraft({ label: '', kind: draft.kind, baseUrl: '', apiKey: '', models: '', sizeStyle: draft.sizeStyle });
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

    function select(name, label, value, options, onChange) {
      return React.createElement('div', { className: 'kimg-field', key: name },
        React.createElement('label', null, label),
        React.createElement('select', {
          value: value === undefined || value === null ? '' : value,
          onChange: function (event) { onChange(event.target.value); },
        }, options.map(function (option) {
          return React.createElement('option', { key: option, value: option }, option);
        })));
    }

    var inject = ['slots'];

    function apply(ctx) {
      var removeStyles = ensureStyles();
      if (removeStyles !== null && ctx && typeof ctx.effect === 'function') {
        ctx.effect(function () { return removeStyles; }, 'dsh-kylin-images: settings styles');
      }
      if (!ctx || !ctx.slots || typeof ctx.slots.inject !== 'function') return;

      function bindSeat(seat, options, label) {
        try {
          ctx.slots.inject(seat, function () {
            return ctx.slots.register(Object.assign({ name: seat, locale: 'kylinImages' }, options), VisionModelCard);
          });
        } catch (error) {
          console.warn('[dsh-kylin-images] 宿主缺少插槽 ' + seat + '，已跳过 ' + label + ':', error && error.message);
        }
      }

      // 主面：插件详情页配置卡（QiLin 3.x / DSH 0.2.x）
      bindSeat('plugins.bundle.config', { key: 'dsh-kylin-images' }, 'plugins.bundle.config');
      // 兜底面：设置壳的动态分区（DSH 0.1.x 系）
      bindSeat('settings.section', { id: SECTION_ID, order: 55, label: t('nav') }, 'settings.section');
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
