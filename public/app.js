(() => {
  'use strict';

  const form = document.getElementById('name-form');
  const submitBtn = document.getElementById('submit-btn');
  const outputCard = document.getElementById('output-card');
  const resultEl = document.getElementById('result');
  const statusEl = document.getElementById('status');

  /** 采集表单数据 */
  function collect() {
    return {
      provider: document.getElementById('provider').value,
      surname: document.getElementById('surname').value.trim(),
      gender: document.getElementById('gender').value,
      style: document.getElementById('style').value,
      requirements: document.getElementById('requirements').value.trim(),
      keywords: document.getElementById('keywords').value.trim(),
    };
  }

  /** 渲染一段新增文本（保留原样，含换行） */
  function appendText(text) {
    resultEl.textContent += text;
    // 自动滚动到底部
    outputCard.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function setStatus(text, cls = '') {
    statusEl.textContent = text;
    statusEl.className = 'status' + (cls ? ' ' + cls : '');
  }

  function setResultDone() {
    resultEl.classList.add('stream-done');
  }

  /** 逐块消费 SSE 流 */
  async function streamResult(body) {
    const resp = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || `请求失败（HTTP ${resp.status}）`);
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6).trim();
        if (payload === '[DONE]') continue;

        let msg;
        try { msg = JSON.parse(payload); } catch (e) { continue; }

        switch (msg.type) {
          case 'content':
            appendText(msg.text);
            break;
          case 'ready':
            setStatus(`生成中（${msg.label || msg.provider} · ${msg.model}）`);
            break;
          case 'done':
            setStatus('已完成', 'done');
            setResultDone();
            break;
          case 'error':
            throw new Error(msg.message || '生成出错');
        }
      }
    }
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = collect();

    // 表单校验：至少要有一点输入
    if (!body.surname && !body.requirements && !body.keywords) {
      setStatus('请至少填写姓氏或起名需求', 'error');
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = '生成中…';
    resultEl.textContent = '';
    resultEl.classList.remove('stream-done');
    outputCard.hidden = false;
    setStatus('正在连接…');

    try {
      await streamResult(body);
    } catch (err) {
      setStatus('出错了', 'error');
      appendText('\n【错误】' + (err.message || '未知错误'));
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = '开始起名';
    }
  });
})();
