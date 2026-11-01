// ==UserScript==
// @name         智联招聘自动投递助手 (zhaopin-auto-apply)
// @namespace    https://github.com/codex/zhaopin-auto-apply
// @version      0.5.4
// @description  智联招聘网页端辅助：列表批量投递、详情页一键投递、AI 自动作答投递提问、AI 自动回复 HR 聊天（OpenAI 兼容接口可配置）
// @author       codex
// @match        *://*.zhaopin.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_notification
// @grant        GM_registerMenuCommand
// @connect      *
// @run-at       document-idle
// @license      MIT
// ==/UserScript==

(function () {
  'use strict';

  /* ============================================================
   * 1. 选择器配置区
   * 智联前端经常改版，所有 DOM 选择器集中在这里，失效时优先改这里。
   * 每项都是数组，按顺序尝试，命中第一个即返回。
   * ============================================================ */
  const SEL = {
    // 列表页岗位卡片
    listCard: [
      '.joblist-box__item',
      '.joblist-box .joblist-item',
      'div[class*="job-card"]',
      'div[class*="jobCard"]',
      'div[class*="position-card"]',
    ],
    // 卡片内岗位标题链接（用于提取岗位名和详情 URL）
    cardLink: [
      'a[href*="jobdetail"]',
      'a[href*="jobs.zhaopin.com"]',
      'a[href*=".htm"]',
    ],
    // 卡片上的“已投递”标记文本
    deliveredText: ['已投递', '继续投递'],
    // 详情页 / 弹层中的投递按钮（按文本匹配）
    applyBtnText: ['投递简历', '立即投递', '立即申请'],
    appliedBtnText: ['已投递', '已申请'],
    // 简历选择弹窗
    resumeDialog: [
      'div[class*="resume"][class*="dialog"]',
      'div[class*="resume-select"]',
      'div[class*="modal"] [class*="resume"]',
      '.resume-list',
    ],
    resumeItem: [
      '[class*="resume-item"]',
      '[class*="resumeItem"]',
      '.resume-list > *',
    ],
    // 提问表单：容器内的 label + 输入控件
    questionDialog: [
      'div[class*="question"]',
      'div[class*="apply-form"]',
      'form[class*="deliver"]',
    ],
    // 成功提示
    successText: ['投递成功', '已成功投递', '投递已完成', '已向对方发送简历', '沟通已发起'],
    // 智联“已发送简历和打招呼语”专属弹窗（真实结构，teleport 到 body）
    deliverModal: ['.deliver-greeting-modal__box', '[class*="deliver-greeting-modal"]'],
    deliverModalStay: ['.deliver-greeting-modal__btn--secondary', '[class*="deliver-greeting-modal"] [class*="btn--secondary"]'],
    // 验证码 / 风控特征
    captcha: [
      'iframe[src*="captcha"]',
      'iframe[src*="verify"]',
      '[class*="geetest"]',
      '[class*="nc_iconfont"]',      // 阿里云滑块
      '[id*="nc_"][class*="stage"]',
      '[class*="slider-captcha"]',
      '[class*="verify-wrap"]',
    ],
    captchaText: ['拖动滑块', '安全验证', '滑动验证', '完成验证', '操作频繁'],
    // 新版搜索页右侧详情面板（左右分栏布局）
    detailPanel: [
      '.job-split-layout__right',
      '[class*="job-detail"]',
      '[class*="jobDetail"]',
      '[class*="position-detail"]',
    ],
    // 消息中心
    chatRoot: [
      '[class*="chat-container"]',
      '[class*="im-container"]',
      '[class*="message-container"]',
      '[class*="conversation"]',
    ],
    chatItem: [
      '[class*="session-item"]',
      '[class*="conversation-item"]',
      '[class*="chat-item"]',
      '[class*="im-list"] li',
    ],
    chatUnreadBadge: [
      '[class*="unread"]',
      '[class*="badge"]',
      '[class*="red-dot"]',
      '[class*="reddot"]',
      'sup',
    ],
    chatMessageRow: [
      '[class*="message-item"]',
      '[class*="msg-item"]',
      '[class*="bubble"]',
    ],
    chatSelfFlag: ['self', 'right', 'mine', 'own'],
    chatInput: [
      '[contenteditable="true"]',
      'textarea[class*="input"]',
      'textarea',
      '[class*="editor"] [contenteditable="true"]',
    ],
    chatSendBtnText: ['发送'],
  };

  /* ============================================================
   * 2. 公共工具
   * ============================================================ */
  const LS_PREFIX = 'zlaa_';
  const store = {
    get(key, defVal) {
      try {
        const raw = localStorage.getItem(LS_PREFIX + key);
        return raw === null ? defVal : JSON.parse(raw);
      } catch (e) { return defVal; }
    },
    set(key, val) {
      localStorage.setItem(LS_PREFIX + key, JSON.stringify(val));
    },
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const randDelay = (min = 3000, max = 8000) => sleep(min + Math.random() * (max - min));

  function qs(doc, selectors) {
    for (const s of selectors) {
      try {
        const el = doc.querySelector(s);
        if (el) return el;
      } catch (e) { /* 非法选择器忽略 */ }
    }
    return null;
  }
  function qsa(doc, selectors) {
    for (const s of selectors) {
      try {
        const list = doc.querySelectorAll(s);
        if (list && list.length) return Array.from(list);
      } catch (e) { /* ignore */ }
    }
    return [];
  }
  // 按可见文本查找元素（button/a/div 等）。
  // 关键规则：若子元素也命中同一文本，则跳过父容器，只返回最深层元素，
  // 避免把「留在此页继续沟通」这种按钮容器当作按钮本身来点。
  function textMatch(el, texts) {
    const t = (el.textContent || '').trim();
    if (!t || t.length > 60) return false;
    for (const want of texts) {
      if (t === want || t.startsWith(want)) return true;
    }
    return false;
  }
  function isDeepestMatch(el, texts) {
    for (const child of el.children) {
      if (textMatch(child, texts)) return false;
    }
    return true;
  }
  function findByText(doc, texts, tagFilter) {
    const candidates = doc.querySelectorAll(tagFilter || 'button, a, div, span, h1, h2, h3, h4, p, li');
    for (const el of candidates) {
      if (!textMatch(el, texts)) continue;
      if (!isDeepestMatch(el, texts)) continue;
      return el;
    }
    return null;
  }
  function findAllByText(doc, texts, tagFilter) {
    const out = [];
    const candidates = doc.querySelectorAll(tagFilter || 'button, a, div, span, h1, h2, h3, h4, p, li');
    for (const el of candidates) {
      const t = (el.textContent || '').trim();
      if (!t || t.length > 60) continue;
      for (const want of texts) {
        if (t.includes(want)) { out.push(el); break; }
      }
    }
    return out;
  }
  function clickable(el) {
    if (!el) return null;
    // 有些站点把 click 绑在父级，向上找 button/a
    return el.closest('button, a, [role="button"]') || el;
  }

  function notify(title, text) {
    try { GM_notification({ title, text, timeout: 8000 }); }
    catch (e) { console.log('[zlaa] 通知:', title, text); }
  }

  // 等待条件成立
  async function waitFor(fn, timeout = 10000, interval = 400) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      try {
        const v = fn();
        if (v) return v;
      } catch (e) { /* ignore */ }
      await sleep(interval);
    }
    return null;
  }

  // 只认岗位详情页 URL：排除公司页、列表页等其他链接
  function isJobDetailUrl(url) {
    if (!url) return false;
    if (/company\.zhaopin\.com|companydetail/i.test(url)) return false; // 公司主页
    if (/jobdetail/i.test(url)) return true;                            // 详情页路由
    if (/[A-Z0-9]{5,}J\d{5,}\.htm/i.test(url)) return true;             // CCxxxJ12345.htm 岗位编号
    if (/jobs\.zhaopin\.com\/.+\.htm/i.test(url)) return true;          // 旧版详情页
    if (/[?&]jobId=\w+/i.test(url)) return true;                        // 带 jobId 参数
    return false;
  }

  function extractJobId(url, fallbackText) {
    let m = url && url.match(/jobId=(\w+)/);
    if (m) return m[1];
    m = url && url.match(/\/([A-Za-z0-9]{8,})\.htm/);
    if (m) return m[1];
    // 退化为文本哈希
    let h = 0;
    const s = (url || '') + '|' + (fallbackText || '');
    for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    return 'h' + Math.abs(h);
  }

  /* ============================================================
   * 3. 已投递记录（localStorage 去重）
   * ============================================================ */
  const deliveredStore = {
    _key: 'delivered',
    _cache: null,
    _load() {
      if (!this._cache) this._cache = store.get(this._key, {});
      return this._cache;
    },
    has(jobId) { return !!this._load()[jobId]; },
    mark(jobId) {
      const d = this._load();
      d[jobId] = Date.now();
      store.set(this._key, d);
    },
  };

  /* ============================================================
   * 4. 设置存储与配置面板 UI
   * ============================================================ */
  const DEFAULT_PROMPT =
    '你是一名正在求职的候选人，请以专业、简洁、诚恳的求职者口吻回答招聘方的问题。' +
    '回答控制在 100 字以内，不要使用表情符号，不要暴露这是 AI 生成的内容。';

  const settings = {
    get apiBase()    { return store.get('apiBase', 'https://api.openai.com/v1'); },
    set apiBase(v)   { store.set('apiBase', v); },
    get apiKey()     { return store.get('apiKey', ''); },
    set apiKey(v)    { store.set('apiKey', v); },
    get model()      { return store.get('model', 'gpt-4o-mini'); },
    set model(v)     { store.set('model', v); },
    get sysPrompt()  { return store.get('sysPrompt', DEFAULT_PROMPT); },
    set sysPrompt(v) { store.set('sysPrompt', v); },
    get bio()        { return store.get('bio', ''); },
    set bio(v)       { store.set('bio', v); },
    get autoReply()  { return store.get('autoReply', true); },
    set autoReply(v) { store.set('autoReply', !!v); },
    get resumeChoice()    { return store.get('resumeChoice', ''); },
    set resumeChoice(v)   { store.set('resumeChoice', v); },
    get jdKeywords()      { return store.get('jdKeywords', ''); },
    set jdKeywords(v)     { store.set('jdKeywords', v); },
    keywordList() {
      // 归一化：小写 + 去空白，兼容 “Lang Chain” / “LangChain” 等写法差异
      return this.jdKeywords.split(/[,，;；]+/)
        .map((s) => s.toLowerCase().replace(/[\s　]+/g, ''))
        .filter(Boolean);
    },
    configured() { return !!(this.apiBase && this.apiKey && this.model); },
  };

  function injectStyles() {
    const css = `
      #zlaa-panel, #zlaa-settings, #zlaa-fab { font-family: "Microsoft YaHei", "PingFang SC", sans-serif; }
      #zlaa-fab {
        position: fixed; right: 16px; bottom: 96px; z-index: 2147483000;
        width: 42px; height: 42px; border-radius: 50%; background: #2f6fed; color: #fff;
        display: flex; align-items: center; justify-content: center; cursor: pointer;
        font-size: 20px; box-shadow: 0 2px 10px rgba(0,0,0,.25); user-select: none;
      }
      #zlaa-panel {
        position: fixed; right: 16px; bottom: 150px; z-index: 2147483000;
        width: 320px; background: #fff; border: 1px solid #d9d9d9; border-radius: 8px;
        box-shadow: 0 4px 16px rgba(0,0,0,.18); padding: 10px; font-size: 13px; color: #333;
      }
      #zlaa-panel h3 { margin: 0 0 8px; font-size: 14px; color: #2f6fed; }
      #zlaa-panel .zlaa-row { display: flex; gap: 6px; margin-bottom: 8px; flex-wrap: wrap; }
      #zlaa-panel button {
        border: 1px solid #2f6fed; background: #fff; color: #2f6fed; border-radius: 4px;
        padding: 4px 10px; cursor: pointer; font-size: 12px;
      }
      #zlaa-panel button.zlaa-primary { background: #2f6fed; color: #fff; }
      #zlaa-panel button:disabled { opacity: .45; cursor: not-allowed; }
      #zlaa-panel .zlaa-progress { margin: 6px 0; color: #666; }
      #zlaa-panel .zlaa-log {
        max-height: 180px; overflow: auto; background: #f7f8fa; border-radius: 4px;
        padding: 6px; font-size: 12px; line-height: 1.6; color: #555;
      }
      #zlaa-panel .zlaa-log .err { color: #d4380d; }
      #zlaa-panel .zlaa-log .ok { color: #389e0d; }
      #zlaa-settings {
        position: fixed; inset: 0; z-index: 2147483001; background: rgba(0,0,0,.35);
        display: flex; align-items: center; justify-content: center;
      }
      #zlaa-settings .zlaa-modal {
        width: 460px; background: #fff; border-radius: 8px; padding: 18px 20px; font-size: 13px;
        max-height: 86vh; overflow: auto; color: #333;
      }
      #zlaa-settings h3 { margin: 0 0 12px; color: #2f6fed; }
      #zlaa-settings label { display: block; margin: 10px 0 4px; font-weight: 600; }
      #zlaa-settings input[type=text], #zlaa-settings input[type=password], #zlaa-settings textarea {
        width: 100%; box-sizing: border-box; border: 1px solid #d9d9d9; border-radius: 4px;
        padding: 6px 8px; font-size: 13px;
      }
      #zlaa-settings textarea { min-height: 70px; resize: vertical; }
      #zlaa-settings .zlaa-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 14px; }
      #zlaa-settings button { border: 1px solid #2f6fed; background: #fff; color: #2f6fed;
        border-radius: 4px; padding: 6px 14px; cursor: pointer; }
      #zlaa-settings button.zlaa-primary { background: #2f6fed; color: #fff; }
      .zlaa-check-wrap { position: absolute; left: 6px; top: 6px; z-index: 10; background: rgba(255,255,255,.9);
        border-radius: 3px; padding: 1px 2px; }
      .zlaa-check-wrap input { width: 16px; height: 16px; cursor: pointer; }
      #zlaa-detail-btn {
        position: fixed; right: 16px; bottom: 40px; z-index: 2147483000;
        background: #ff7a45; color: #fff; border: none; border-radius: 20px;
        padding: 10px 20px; font-size: 14px; cursor: pointer; box-shadow: 0 2px 10px rgba(0,0,0,.25);
      }
    `;
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
  }

  function openSettings() {
    if (document.getElementById('zlaa-settings')) return;
    const wrap = document.createElement('div');
    wrap.id = 'zlaa-settings';
    wrap.innerHTML = `
      <div class="zlaa-modal">
        <h3>自动投递助手 · 设置</h3>
        <label>API 请求地址（OpenAI 兼容，填到 /v1 或完整 /chat/completions 均可）</label>
        <input type="text" id="zlaa-apiBase" value="${escapeHtml(settings.apiBase)}">
        <label>API Key</label>
        <input type="password" id="zlaa-apiKey" value="${escapeHtml(settings.apiKey)}">
        <label>模型名</label>
        <input type="text" id="zlaa-model" value="${escapeHtml(settings.model)}">
        <label>系统提示词（AI 人设）</label>
        <textarea id="zlaa-sysPrompt">${escapeHtml(settings.sysPrompt)}</textarea>
        <label>个人背景（会注入提示词，让 AI 以你的情况作答，可留空）</label>
        <textarea id="zlaa-bio" placeholder="例如：3 年前端经验，熟悉 React/TypeScript，期望杭州，薪资 20-25K">${escapeHtml(settings.bio)}</textarea>
        <label>JD 关键词（逗号分隔，不区分大小写；命中任意一个才投递，留空则不限制）</label>
        <textarea id="zlaa-jdKeywords" placeholder="例如：LangChain, LLM, RAG">${escapeHtml(settings.jdKeywords)}</textarea>
        <label style="margin-top:12px;">
          <input type="checkbox" id="zlaa-autoReply" ${settings.autoReply ? 'checked' : ''}>
          开启 HR 聊天 AI 自动回复
        </label>
        <div class="zlaa-actions">
          <button id="zlaa-test">测试连接</button>
          <button id="zlaa-close">关闭</button>
          <button class="zlaa-primary" id="zlaa-save">保存</button>
        </div>
        <div id="zlaa-test-result" style="margin-top:8px;color:#666;"></div>
      </div>`;
    document.body.appendChild(wrap);

    wrap.querySelector('#zlaa-close').onclick = () => wrap.remove();
    wrap.querySelector('#zlaa-save').onclick = () => {
      settings.apiBase = wrap.querySelector('#zlaa-apiBase').value.trim();
      settings.apiKey = wrap.querySelector('#zlaa-apiKey').value.trim();
      settings.model = wrap.querySelector('#zlaa-model').value.trim();
      settings.sysPrompt = wrap.querySelector('#zlaa-sysPrompt').value.trim() || DEFAULT_PROMPT;
      settings.bio = wrap.querySelector('#zlaa-bio').value.trim();
      settings.jdKeywords = wrap.querySelector('#zlaa-jdKeywords').value.trim();
      settings.autoReply = wrap.querySelector('#zlaa-autoReply').checked;
      notify('自动投递助手', '设置已保存');
      wrap.remove();
    };
    wrap.querySelector('#zlaa-test').onclick = async () => {
      const res = wrap.querySelector('#zlaa-test-result');
      res.textContent = '测试连接中…';
      try {
        const reply = await aiChat('只回复四个字：连接正常', {
          apiBase: wrap.querySelector('#zlaa-apiBase').value.trim(),
          apiKey: wrap.querySelector('#zlaa-apiKey').value.trim(),
          model: wrap.querySelector('#zlaa-model').value.trim(),
        });
        res.textContent = '成功：' + reply;
        res.style.color = '#389e0d';
      } catch (e) {
        res.textContent = '失败：' + e.message;
        res.style.color = '#d4380d';
      }
    };
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* ============================================================
   * 5. AI 调用封装（OpenAI chat/completions 兼容）
   * ============================================================ */
  function chatUrl(base) {
    let b = (base || '').replace(/\/+$/, '');
    if (/\/chat\/completions$/.test(b)) return b;
    if (/\/v1$/.test(b)) return b + '/chat/completions';
    return b + '/v1/chat/completions';
  }

  function gmRequest(options) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        ...options,
        onload: (res) => resolve(res),
        onerror: (err) => reject(new Error('网络请求失败')),
        ontimeout: () => reject(new Error('请求超时')),
      });
    });
  }

  // userContent: 用户消息文本；override: 可选覆盖配置（测试连接时用）
  async function aiChat(userContent, override, history) {
    const cfg = {
      apiBase: override?.apiBase ?? settings.apiBase,
      apiKey: override?.apiKey ?? settings.apiKey,
      model: override?.model ?? settings.model,
    };
    if (!cfg.apiKey) throw new Error('未配置 API Key（点右下角 ⚙ 打开设置）');

    const sysParts = [settings.sysPrompt];
    if (settings.bio) sysParts.push('候选人背景：' + settings.bio);

    const messages = [{ role: 'system', content: sysParts.join('\n') }];
    if (Array.isArray(history)) messages.push(...history);
    messages.push({ role: 'user', content: userContent });

    const res = await gmRequest({
      method: 'POST',
      url: chatUrl(cfg.apiBase),
      timeout: 60000,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + cfg.apiKey,
      },
      data: JSON.stringify({ model: cfg.model, messages, temperature: 0.7 }),
    });

    let json;
    try { json = JSON.parse(res.responseText); }
    catch (e) { throw new Error('接口返回非 JSON（HTTP ' + res.status + '）'); }
    if (res.status < 200 || res.status >= 300) {
      throw new Error('HTTP ' + res.status + '：' + (json.error?.message || res.responseText.slice(0, 200)));
    }
    const text = json.choices?.[0]?.message?.content;
    if (!text) throw new Error('接口未返回内容');
    return text.trim();
  }

  /* ============================================================
   * 6. 投递流程引擎
   * 在任意 document（当前页或 iframe 内）执行一次投递：
   * 点投递按钮 → 处理简历选择 → AI 作答提问 → 等待结果。
   * 返回 'success' | 'delivered' | 'captcha' | 'fail:原因'
   * ============================================================ */
  const FLOW_TIMEOUT = 45000;

  function detectCaptcha(doc) {
    if (qs(doc, SEL.captcha)) return true;
    return findAllByText(doc, SEL.captchaText).length > 0;
  }

  async function waitCaptchaGone(doc, log) {
    log('检测到验证码 / 风控，请在页面上手动完成验证…', 'err');
    notify('自动投递助手', '出现验证码或风控，请手动处理后我继续');
    const ok = await waitFor(() => !detectCaptcha(doc), 180000, 1500);
    if (ok) log('验证已通过，继续投递');
    return ok;
  }

  // 处理简历选择弹窗：优先用记住的选择；没有则等用户手动点一次并记住
  async function handleResumeDialog(doc, dialog, log) {
    const items = qsa(dialog.ownerDocument, SEL.resumeItem)
      .filter((el) => dialog.contains(el));
    if (!items.length) return true; // 无法识别，交给后续流程

    const saved = settings.resumeChoice;
    if (saved) {
      const hit = items.find((el) => (el.textContent || '').includes(saved));
      if (hit) {
        clickable(hit).click();
        await sleep(400);
        const confirmBtn = clickable(findByText(doc, ['确定', '确认', '提交', '投递简历']));
        if (confirmBtn) confirmBtn.click();
        log('已自动选择简历：' + saved);
        return true;
      }
      log('未找到已记住的简历，等待手动选择…', 'err');
    } else {
      log('首次投递：请在弹窗中手动选择一份简历，我会记住它', 'err');
      notify('自动投递助手', '请在简历弹窗中选择一份简历，之后将自动使用');
    }

    // 等待用户点击某个简历项，记录其文本作为后续选择
    const picked = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 60000);
      items.forEach((el) => {
        el.addEventListener('click', () => {
          clearTimeout(timer);
          resolve(el);
        }, { once: true });
      });
    });
    if (picked) {
      const name = (picked.textContent || '').trim().slice(0, 30);
      settings.resumeChoice = name;
      log('已记住简历选择：' + name);
      await sleep(400);
      const confirmBtn = clickable(findByText(doc, ['确定', '确认', '提交', '投递简历']));
      if (confirmBtn) confirmBtn.click();
      return true;
    }
    return false;
  }

  // 处理投递提问表单：提取问题 → AI 作答 → 填入 → 提交
  async function handleQuestionForm(doc, form, log) {
    if (!settings.configured()) {
      log('出现投递提问但未配置 AI，跳过该岗位', 'err');
      return false;
    }
    const inputs = Array.from(form.querySelectorAll('textarea, input[type="text"]'));
    if (!inputs.length) return false;

    for (const input of inputs) {
      // 向上找问题文本：最近的 label / 标题元素
      const container = input.closest('div[class*="item"], li, .form-item, div') || input.parentElement;
      let question = '';
      let node = input;
      for (let i = 0; i < 4 && node; i++) {
        node = node.parentElement;
        if (!node) break;
        const clone = node.cloneNode(true);
        clone.querySelectorAll('input, textarea').forEach((el) => el.remove());
        const t = (clone.textContent || '').trim();
        if (t && t.length >= 4 && t.length <= 200) { question = t; break; }
      }
      if (!question) question = '请填写该申请表单字段';
      try {
        log('AI 作答：' + question.slice(0, 40) + '…');
        const answer = await aiChat('招聘方在投递时提问：「' + question + '」请直接给出填写内容本身，不要加引号或解释。');
        input.focus();
        input.value = answer.slice(0, 500);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        await sleep(300);
      } catch (e) {
        log('AI 作答失败：' + e.message, 'err');
        return false;
      }
    }
    await sleep(500);
    const submitBtn = clickable(findByText(doc, ['提交', '确定', '确认投递', '投递简历', '立即投递']));
    if (submitBtn) submitBtn.click();
    return true;
  }

  // 投递成功后的确认弹窗：点“留在此页”关闭，停留在当前页继续批量投递
  function dismissSuccessDialog(doc) {
    const stay = clickable(findByText(doc, ['留在此页', '我知道了', '完成', '关闭']));
    if (stay) { stay.click(); return; }
    const closeIcon = doc.querySelector(
      '[class*="dialog"] [class*="close"], [class*="modal"] [class*="close"], [class*="el-dialog__close"], [aria-label="Close"]');
    if (closeIcon) closeIcon.click();
  }

  async function applyFlowInDoc(doc, log, extraText) {
    // doc 可以是 document（整页投递）或 element（右侧详情面板投递）
    const scopeRoot = doc.body || doc;
    const scopeText = () => (scopeRoot.innerText || '');
    const scopeTitle = doc.title || document.title || '';
    // 弹窗（成功确认/简历选择/提问/验证码）常被 teleport 到 body 下，
    // 不在面板作用域内，这类检测一律在整篇 document 里做
    const rootDoc = doc.ownerDocument || doc;

    // 0. JD 关键词匹配：先等 JD 异步渲染出来，再检查全文，不命中直接跳过
    const keywords = settings.keywordList();
    if (keywords.length) {
      // JD 是异步加载的，等到文本量足够（或超时 10s）再匹配
      await waitFor(() => scopeText().length > 300, 10000, 600);

      const norm = (s) => s.toLowerCase().replace(/[\s　]+/g, '');
      const parts = [scopeText(), scopeTitle, extraText || ''];
      // 补充 meta 描述（整页模式下 JD 摘要可能在 meta 里）
      const meta = doc.querySelector && doc.querySelector('meta[name="description"], meta[property="og:description"]');
      if (meta) parts.push(meta.getAttribute('content') || '');
      const haystack = norm(parts.join('\n'));

      const hit = keywords.find((kw) => haystack.includes(kw));
      if (!hit) {
        const t = scopeText();
        log('未命中关键词 ' + JSON.stringify(keywords) + '，文本长度 ' + t.length + '，片段：' + t.slice(0, 150).replace(/\s+/g, ' '));
        return 'nomatch';
      }
      log('JD 关键词匹配通过（命中：' + hit + '）');
    }

    // 1. 找投递按钮
    const start = Date.now();
    const applyBtn = await waitFor(() => {
      const applied = clickable(findByText(doc, SEL.appliedBtnText));
      if (applied) return { applied: true };
      const btn = clickable(findByText(doc, SEL.applyBtnText));
      return btn ? { btn } : null;
    }, 10000, 500);

    if (!applyBtn) return 'fail:未找到投递按钮（选择器可能已失效）';
    if (applyBtn.applied) return 'delivered';

    applyBtn.btn.click();
    log('已点击投递按钮，等待后续弹窗…');

    // 2. 状态循环：验证码 / 简历选择 / 提问表单 / 成功（弹窗检测均在整篇 document）
    let resumeHandled = false;
    let questionHandled = false;
    while (Date.now() - start < FLOW_TIMEOUT) {
      await sleep(800);

      if (detectCaptcha(rootDoc)) {
        const ok = await waitCaptchaGone(rootDoc, log);
        if (!ok) return 'captcha';
        continue;
      }

      // 成功判断 1：智联专属成功弹窗，直接点“留在此页”
      const deliverModal = qs(rootDoc, SEL.deliverModal);
      if (deliverModal) {
        const stayBtn = qs(deliverModal, SEL.deliverModalStay) ||
          clickable(findByText(deliverModal, ['留在此页']));
        if (stayBtn) stayBtn.click();
        return 'success';
      }

      // 成功判断 2：通用成功文案 / 已投递状态，自动关闭弹窗再返回
      if (findAllByText(rootDoc, SEL.successText).length > 0) {
        dismissSuccessDialog(rootDoc);
        return 'success';
      }
      const appliedNow = clickable(findByText(doc, SEL.appliedBtnText)) ||
        clickable(findByText(rootDoc, SEL.appliedBtnText));
      if (appliedNow) {
        dismissSuccessDialog(rootDoc);
        return 'success';
      }

      // 简历选择弹窗
      const resumeDialog = qs(rootDoc, SEL.resumeDialog);
      if (resumeDialog && !resumeHandled) {
        resumeHandled = true;
        const ok = await handleResumeDialog(rootDoc, resumeDialog, log);
        if (!ok) return 'fail:简历选择超时';
        continue;
      }

      // 提问表单
      const qDialog = qs(rootDoc, SEL.questionDialog);
      if (qDialog && !questionHandled) {
        questionHandled = true;
        const ok = await handleQuestionForm(rootDoc, qDialog, log);
        if (!ok) return 'fail:提问表单处理失败';
        continue;
      }
    }
    return 'fail:等待投递结果超时';
  }

  /* ============================================================
   * 7. 持续投递状态（跨页面持久化）
   * 投递在真实页面上进行：列表页 → 跳转详情页执行投递 → 返回列表。
   * 状态存 localStorage，页面跳转 / 刷新后自动续跑。
   * ============================================================ */
  const run = {
    _key: 'batchRun',
    _d: undefined,
    _load() {
      if (this._d === undefined) this._d = store.get(this._key, null);
      return this._d;
    },
    _save() { store.set(this._key, this._d); },
    active() { const d = this._load(); return !!(d && d.active); },
    start(listUrl) {
      this._d = { active: true, listUrl, seen: [], ok: 0, skip: 0, fail: 0, total: 0, noNew: 0, lastFailId: '', startedAt: Date.now() };
      this._save();
    },
    stop() { const d = this._load(); if (d) { d.active = false; this._save(); } },
    data() { return this._load(); },
    addSeen(id) {
      const d = this._load(); if (!d) return;
      d.seen.push(id);
      if (d.seen.length > 3000) d.seen = d.seen.slice(-2000);
      this._save();
    },
    hasSeen(id) { const d = this._load(); return !!(d && d.seen.includes(id)); },
    bump(field) { const d = this._load(); if (d) { d[field] = (d[field] || 0) + 1; this._save(); } },
    set(field, v) { const d = this._load(); if (d) { d[field] = v; this._save(); } },
  };

  // 详情页顶部的批量投递状态条（含停止按钮）
  function showBatchBadge(text) {
    let badge = document.getElementById('zlaa-batch-badge');
    if (!badge) {
      badge = document.createElement('div');
      badge.id = 'zlaa-batch-badge';
      badge.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);top:12px;z-index:2147483000;' +
        'background:#2f6fed;color:#fff;padding:8px 16px;border-radius:20px;font-size:13px;' +
        'box-shadow:0 2px 10px rgba(0,0,0,.25);display:flex;gap:10px;align-items:center;' +
        'font-family:"Microsoft YaHei","PingFang SC",sans-serif;';
      const span = document.createElement('span');
      span.id = 'zlaa-batch-badge-text';
      const stopBtn = document.createElement('button');
      stopBtn.textContent = '停止投递';
      stopBtn.style.cssText = 'background:#fff;color:#d4380d;border:none;border-radius:12px;' +
        'padding:2px 10px;cursor:pointer;font-size:12px;';
      stopBtn.onclick = () => { run.stop(); showBatchBadge('已手动停止'); };
      badge.appendChild(span);
      badge.appendChild(stopBtn);
      document.body.appendChild(badge);
    }
    document.getElementById('zlaa-batch-badge-text').textContent = text;
  }

  /* ============================================================
   * 8. 列表页模块（持续投递：自动遍历筛选结果，无需勾选）
   * 点开始：记录列表 URL → 跳到第一个岗位详情页投递 → 返回列表 → 下一个。
   * 当前页投完自动滚动 / 翻页，整页刷新后由 onload 自动续跑。
   * ============================================================ */
  function getJobCards() {
    let cards = qsa(document, SEL.listCard);
    // 兜底：包含岗位链接且尺寸合理的容器
    if (!cards.length) {
      const links = qsa(document, SEL.cardLink);
      const seen = new Set();
      cards = [];
      for (const a of links) {
        let p = a;
        for (let i = 0; i < 4 && p.parentElement; i++) p = p.parentElement;
        if (p && !seen.has(p)) { seen.add(p); cards.push(p); }
      }
    }
    // 去嵌套：只保留最外层的卡片容器（子元素如 job-card__title-row 也会命中选择器）
    cards = cards.filter((c) => !cards.some((o) => o !== c && o.contains(c)));
    return cards;
  }

  function parseCard(card) {
    // 优先找岗位详情页链接；新版页面卡片可能没有 href（点击由 JS 处理），
    // 此时退化为“元素模式”：url 为 null，靠点击卡片在右侧面板投递
    let link = null;
    const anchors = Array.from(card.querySelectorAll('a[href]'));
    const preferred = qs(card, SEL.cardLink);
    if (preferred) anchors.unshift(preferred);
    for (const a of anchors) {
      if (a && a.href && isJobDetailUrl(a.href)) { link = a; break; }
    }
    if (!link && !parseCard._logged) {
      parseCard._logged = true;
      console.log('[zlaa] 卡片无岗位详情链接，使用点击卡片模式。锚点样本：',
        anchors.slice(0, 6).map((a) => a && a.href));
    }
    const titleEl = link || qs(card, ['[class*="job-card__name"]', '[class*="name"]', '[class*="title"]']) || card;
    const title = (titleEl.textContent || '').trim().slice(0, 50) || '未命名岗位';
    const cardText = card.textContent || '';
    const url = link ? link.href : null;
    const jobId = url
      ? extractJobId(url, title)
      : extractJobId(null, title + '|' + cardText.slice(0, 60));
    const deliveredOnPage = SEL.deliveredText.some((t) => cardText.includes(t));
    return { url, title, jobId, deliveredOnPage, card };
  }

  // 无链接模式：点击卡片 → 等右侧详情面板 → 在面板内执行投递
  async function applyViaCardClick(job, log) {
    const before = location.href;
    const target = job.card.querySelector('[class*="job-card__name"], a, [class*="title"]') || job.card;
    job.card.scrollIntoView({ block: 'center' });
    await sleep(500);
    clickable(target).click();

    // 等待：URL 变化（整页跳转）或右侧详情面板出现投递按钮
    const outcome = await waitFor(() => {
      if (location.href !== before) return 'nav';
      const panel = qs(document, SEL.detailPanel);
      if (panel && findByText(panel, SEL.applyBtnText.concat(SEL.appliedBtnText))) return panel;
      return null;
    }, 12000, 600);

    if (!outcome) return 'fail:点击卡片后详情面板未加载';
    if (outcome === 'nav') return 'navigated'; // 页面已跳转到详情页，由 onload 批量逻辑接管
    await sleep(1200); // 等面板 JD 渲染稳定
    return applyFlowInDoc(outcome, log, (job.card && job.card.innerText) || '');
  }

  function getAllJobsOnPage() {
    return getJobCards().map(parseCard).filter(Boolean);
  }

  // 尝试加载更多岗位：滚动到底 + 点击“下一页”/“加载更多”
  async function loadMoreJobs(log) {
    window.scrollTo(0, document.body.scrollHeight);
    await sleep(800);
    const nextBtn = clickable(findByText(document, ['下一页', '加载更多', '查看更多']));
    if (nextBtn) {
      log('点击翻页 / 加载更多…');
      nextBtn.click();
    }
    await sleep(3000);
  }

  // 选出下一个要投的岗位（跳过本次已处理 / 已投递的）
  function pickNextJob() {
    for (const job of getAllJobsOnPage()) {
      if (run.hasSeen(job.jobId)) continue;
      if (job.deliveredOnPage || deliveredStore.has(job.jobId)) {
        run.addSeen(job.jobId);
        run.bump('skip');
        continue;
      }
      return job;
    }
    return null;
  }

  function updatePanelProgress() {
    const el = document.getElementById('zlaa-progress');
    const d = run.data();
    if (!el || !d) return;
    el.textContent = `已处理 ${d.total}　成功 ${d.ok}　跳过 ${d.skip}　失败 ${d.fail}`;
  }

  function finishBatch(log) {
    const d = run.data() || { ok: 0, skip: 0, fail: 0 };
    run.stop();
    updatePanelProgress();
    const msg = `投递结束：成功 ${d.ok}，跳过 ${d.skip}，失败 ${d.fail}`;
    log(msg, d.ok > 0 ? 'ok' : 'err');
    notify('自动投递助手', msg);
    const startBtn = document.getElementById('zlaa-start');
    const stopBtn = document.getElementById('zlaa-stop');
    if (startBtn) startBtn.disabled = false;
    if (stopBtn) stopBtn.disabled = true;
  }

  let batchTicking = false;
  async function continueBatch(log) {
    if (!run.active() || batchTicking) return;
    batchTicking = true;
    try {
      while (run.active()) {
        const ready = await waitFor(() => getAllJobsOnPage().length >= 1, 15000, 800);
        updatePanelProgress();
        if (!ready) { log('列表没有渲染出岗位，停止投递', 'err'); finishBatch(log); return; }
        await sleep(1500);

        const job = pickNextJob();
        if (!job) {
          const noNew = (run.data().noNew || 0) + 1;
          run.set('noNew', noNew);
          if (noNew >= 3) { log('连续多次没有新岗位，投递结束'); finishBatch(log); return; }
          log(`当前没有新岗位，尝试滚动 / 翻页（第 ${noNew} 次）…`);
          await loadMoreJobs(log);
          if (!run.active()) { finishBatch(log); return; }
          continue; // 若整页跳转，由新页面 onload 续跑；懒加载则下一轮循环扫描
        }

        run.set('noNew', 0);
        run.addSeen(job.jobId);
        run.bump('total');
        updatePanelProgress();

        // 模式一：卡片有详情链接 → 跳转详情页投递（onload 续跑）
        if (job.url && isJobDetailUrl(job.url)) {
          log(`打开岗位：${job.title}`);
          await randDelay(1500, 3000);
          run.set('expectReturn', true);   // 标记：从详情页回来时自动续跑
          location.href = job.url;
          return;
        }

        // 模式二：卡片无链接 → 点击卡片，在右侧详情面板投递
        log(`点击卡片投递：${job.title}`);
        let result = await applyViaCardClick(job, log);
        if (result === 'navigated') return; // 页面已跳详情页，由 onload 接管
        if (result !== 'success' && result !== 'delivered' && result !== 'nomatch' && result !== 'captcha') {
          log('重试一次：' + job.title);
          await sleep(2000);
          result = await applyViaCardClick(job, log);
          if (result === 'navigated') return;
        }

        if (result === 'success' || result === 'delivered') {
          deliveredStore.mark(job.jobId);
          run.bump('ok');
          log('投递成功：' + job.title, 'ok');
        } else if (result === 'nomatch') {
          run.bump('skip');
          log('JD 不含关键词，跳过：' + job.title);
        } else if (result === 'captcha') {
          log('验证码未处理，停止投递', 'err');
          finishBatch(log);
          return;
        } else {
          run.bump('fail');
          log(result + '（' + job.title + '）', 'err');
        }
        updatePanelProgress();
        if (run.active()) await randDelay();
      }
    } finally {
      batchTicking = false;
    }
  }

  function buildPanel() {
    if (document.getElementById('zlaa-panel')) return;
    const panel = document.createElement('div');
    panel.id = 'zlaa-panel';
    panel.innerHTML = `
      <h3>智联自动投递</h3>
      <div class="zlaa-row">
        <button class="zlaa-primary" id="zlaa-start">开始投递（全部岗位）</button>
        <button id="zlaa-stop" disabled>停止</button>
        <button id="zlaa-open-settings">设置</button>
      </div>
      <div class="zlaa-progress" id="zlaa-progress">就绪：筛选好岗位后点“开始投递”</div>
      <div class="zlaa-log" id="zlaa-log"></div>`;
    document.body.appendChild(panel);

    const logEl = panel.querySelector('#zlaa-log');
    const log = (msg, cls) => {
      const line = document.createElement('div');
      if (cls) line.className = cls;
      line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
      logEl.appendChild(line);
      logEl.scrollTop = logEl.scrollHeight;
    };
    window.__zlaaLog = log;

    panel.querySelector('#zlaa-open-settings').onclick = () => openSettings();
    panel.querySelector('#zlaa-stop').onclick = () => {
      run.stop();
      log('已停止（当前页面的投递会执行完最后一步）');
      panel.querySelector('#zlaa-start').disabled = false;
      panel.querySelector('#zlaa-stop').disabled = true;
    };
    panel.querySelector('#zlaa-start').onclick = async () => {
      if (run.active()) return;
      const count = getAllJobsOnPage().length;
      if (!count) { log('当前页面没识别到岗位卡片，请检查筛选结果是否已加载', 'err'); return; }
      log(`识别到 ${count} 个岗位，开始持续投递（会自动翻页/加载更多）`);
      if (!settings.configured()) {
        log('提示：未配置 AI，遇到提问表单的岗位会被跳过', 'err');
      }
      run.start(location.href);
      panel.querySelector('#zlaa-start').disabled = true;
      panel.querySelector('#zlaa-stop').disabled = false;
      updatePanelProgress();
      await continueBatch(log);
    };
  }

  function initListPage() {
    buildPanel();
    // 只有“从详情页返回列表”才自动续跑；手动刷新页面一律自动停止，
    // 避免换代码刷新时 unintended 自动开投
    if (run.active() && run.data() && run.data().expectReturn) {
      run.set('expectReturn', false);
      const log = window.__zlaaLog || ((m) => console.log('[zlaa]', m));
      log('批量投递进行中，继续下一个…');
      const startBtn = document.getElementById('zlaa-start');
      const stopBtn = document.getElementById('zlaa-stop');
      if (startBtn) startBtn.disabled = true;
      if (stopBtn) stopBtn.disabled = false;
      setTimeout(() => continueBatch(log), 1200);
    } else if (run.active()) {
      run.stop();
      const log = window.__zlaaLog || ((m) => console.log('[zlaa]', m));
      log('检测到中途中断的投递任务，已自动停止；点击「开始投递」可重新开始');
    }
  }

  /* ============================================================
   * 9. 详情页模块（悬浮一键投递按钮 + 批量模式自动投递）
   * ============================================================ */
  function isDetailPage() {
    if (/jobs\.zhaopin\.com\//.test(location.href) && /\.htm/.test(location.href)) return true;
    return !!findByText(document, SEL.applyBtnText);
  }

  // 批量模式：在真实详情页上执行投递，完成后返回列表
  async function runDetailBatch() {
    const d0 = run.data();
    showBatchBadge(`批量投递中（已处理 ${d0 ? d0.total : 0}）`);
    // 校验当前确实是岗位详情页（防止误入公司页等其他页面）
    if (!isJobDetailUrl(location.href)) {
      run.bump('skip');
      showBatchBadge('当前不是岗位详情页，跳过并返回列表…');
      await sleep(1500);
      location.href = (d0 && d0.listUrl) || 'https://sou.zhaopin.com/';
      return;
    }
    const jobId = extractJobId(location.href, document.title);
    const log = (m) => console.log('[zlaa]', m);
    await sleep(2000); // 等页面稳定，JD 异步渲染

    const result = await applyFlowInDoc(document, log);
    let label;
    if (result === 'success' || result === 'delivered') {
      deliveredStore.mark(jobId);
      run.bump('ok');
      label = '✓ 投递成功';
    } else if (result === 'nomatch') {
      run.bump('skip');
      label = 'JD 不匹配，跳过';
    } else if (result === 'captcha') {
      run.stop();
      showBatchBadge('验证码未处理，批量投递已停止');
      notify('自动投递助手', '验证码未完成，批量投递已停止');
      return;
    } else {
      // 失败重试一次：刷新本页重新走一遍流程
      const d = run.data();
      if (d && d.lastFailId !== jobId) {
        run.set('lastFailId', jobId);
        showBatchBadge('投递失败，刷新重试一次…');
        await sleep(1500);
        location.reload();
        return;
      }
      run.set('lastFailId', '');
      run.bump('fail');
      label = '✗ ' + result;
    }

    const d2 = run.data() || { ok: 0, skip: 0, fail: 0, listUrl: '' };
    showBatchBadge(`${label}　成功 ${d2.ok} / 跳过 ${d2.skip} / 失败 ${d2.fail}，返回列表…`);
    await randDelay(1500, 3000);
    run.set('expectReturn', true);       // 标记：返回列表后自动续跑
    location.href = d2.listUrl || document.referrer || 'https://sou.zhaopin.com/';
  }

  function initDetailPage() {
    // 批量模式进行中：自动投递，不再显示手动按钮
    if (run.active()) {
      runDetailBatch();
      return;
    }
    if (document.getElementById('zlaa-detail-btn')) return;
    const btn = document.createElement('button');
    btn.id = 'zlaa-detail-btn';
    btn.textContent = '⚡ 一键投递';
    document.body.appendChild(btn);

    btn.onclick = async () => {
      const jobId = extractJobId(location.href, document.title);
      if (deliveredStore.has(jobId)) {
        notify('自动投递助手', '该岗位本地记录已投递，如确需重投请清除记录');
      }
      btn.disabled = true;
      btn.textContent = '投递中…';
      const log = (msg) => console.log('[zlaa]', msg);
      try {
        const result = await applyFlowInDoc(document, log);
        if (result === 'success' || result === 'delivered') {
          deliveredStore.mark(jobId);
          btn.textContent = '✓ 已投递';
          notify('自动投递助手', '投递成功');
        } else if (result === 'nomatch') {
          btn.textContent = '⚡ 一键投递';
          notify('自动投递助手', 'JD 不含关键词，未投递');
        } else {
          btn.textContent = '⚡ 一键投递';
          notify('自动投递助手', result);
        }
      } finally {
        btn.disabled = false;
      }
    };
  }

  /* ============================================================
   * 10. 消息中心模块（轮询未读会话 → AI 生成回复 → 自动发送）
   * 要求消息中心标签页保持打开。
   * ============================================================ */
  const chatState = {
    handled: new Set(),   // 会话 key + 最后消息文本 哈希，防止重复回复
    busy: false,
  };

  function hashStr(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    return 'k' + Math.abs(h);
  }

  function findChatItems() {
    const items = qsa(document, SEL.chatItem);
    if (!items.length) return [];
    return items.filter((el) => {
      // 有未读标记的会话
      for (const s of SEL.chatUnreadBadge) {
        try {
          const badge = el.querySelector(s);
          if (badge && (badge.textContent || '').trim() !== '') return true;
        } catch (e) { /* ignore */ }
      }
      return false;
    });
  }

  function readChatMessages() {
    const rows = qsa(document, SEL.chatMessageRow);
    const msgs = [];
    for (const row of rows.slice(-10)) {
      const cls = (row.className || '').toString().toLowerCase();
      const isSelf = SEL.chatSelfFlag.some((f) => cls.includes(f));
      const text = (row.textContent || '').trim().slice(0, 300);
      if (text) msgs.push({ role: isSelf ? 'me' : 'hr', text });
    }
    return msgs;
  }

  async function replyCurrentConversation() {
    const msgs = readChatMessages();
    if (!msgs.length) return false;
    const last = msgs[msgs.length - 1];
    if (last.role !== 'hr') return false; // 最后一条是自己发的，无需回复

    const key = hashStr(msgs.map((m) => m.role + ':' + m.text).join('|'));
    if (chatState.handled.has(key)) return false;

    const history = msgs.slice(0, -1).map((m) => ({
      role: m.role === 'me' ? 'assistant' : 'user',
      content: m.text,
    }));
    const answer = await aiChat(last.text, null, history);

    const input = qs(document, SEL.chatInput);
    if (!input) throw new Error('未找到聊天输入框');
    input.focus();
    if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
      input.value = answer;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      input.textContent = answer;
      input.dispatchEvent(new InputEvent('input', { bubbles: true }));
    }
    await sleep(500);
    const sendBtn = clickable(findByText(document, SEL.chatSendBtnText));
    if (sendBtn) sendBtn.click();
    else {
      // 退化为回车发送
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
    }
    chatState.handled.add(key);
    return true;
  }

  async function chatPollTick() {
    if (chatState.busy) return;
    if (!settings.autoReply || !settings.configured()) return;
    chatState.busy = true;
    try {
      const unread = findChatItems();
      for (const item of unread.slice(0, 3)) {
        item.click();
        await sleep(1500);
        try {
          const replied = await replyCurrentConversation();
          if (replied) console.log('[zlaa] 已自动回复一条 HR 消息');
        } catch (e) {
          console.warn('[zlaa] 自动回复失败：', e.message);
        }
        await sleep(1000);
      }
    } finally {
      chatState.busy = false;
    }
  }

  function initChatPage() {
    // 检测到聊天界面特征才启动轮询
    const check = () => qs(document, SEL.chatRoot) || qsa(document, SEL.chatItem).length > 0;
    waitFor(check, 15000, 1000).then((found) => {
      if (!found) return;
      console.log('[zlaa] 检测到消息中心，启动 AI 自动回复轮询');
      setInterval(chatPollTick, 8000);
    });
  }

  /* ============================================================
   * 11. 初始化
   * ============================================================ */
  function injectFab() {
    if (document.getElementById('zlaa-fab')) return;
    const fab = document.createElement('div');
    fab.id = 'zlaa-fab';
    fab.textContent = '⚙';
    fab.title = '自动投递助手设置';
    fab.onclick = openSettings;
    document.body.appendChild(fab);
  }

  function isListPage() {
    if (/sou\.zhaopin\.com/.test(location.host)) return true;
    return getJobCards().length >= 2;
  }

  function main() {
    if (window !== window.top) return; // 只在顶层页面运行，iframe 由父页面操控
    injectStyles();
    injectFab();
    try { GM_registerMenuCommand('打开设置', openSettings); } catch (e) { /* ignore */ }

    if (isListPage()) {
      console.log('[zlaa] 检测到职位列表页，注入批量投递面板');
      initListPage();
      return; // 列表页和详情页逻辑互斥
    }
    if (isDetailPage()) {
      console.log('[zlaa] 检测到职位详情页，注入一键投递按钮');
      initDetailPage();
    }
    initChatPage();
  }

  // 调试句柄：控制台输入 __zlaa.getAllJobsOnPage() 可查看识别结果
  window.__zlaa = {
    version: '0.4.2',
    SEL, settings, run, deliveredStore,
    getJobCards, getAllJobsOnPage, isJobDetailUrl, applyFlowInDoc,
    findByText, findAllByText, dismissSuccessDialog,
  };

  if (document.readyState === 'complete') main();
  else window.addEventListener('load', main);
})();
