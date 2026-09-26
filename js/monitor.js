// シリアルモニタの表示（受信・送信・システムメッセージ、時刻、自動スクロール、ログ保存用テキスト）
import { formatClock } from './util.js';

const MAX_LINES = 10000;
const MAX_LINE_LENGTH = 4000;
const FLUSH_MS = 30;
const BOTTOM_SLACK = 32;

export class Monitor {
  autoscroll = true;
  showTime = false;
  #el;
  #jump;
  #lines = [];
  #open = null; // 改行がまだ来ていない受信行
  #pending = '';
  #timer = 0;

  constructor(el, jumpButton) {
    this.#el = el;
    this.#jump = jumpButton;
    el.addEventListener('scroll', () => this.#updateJump());
    jumpButton.addEventListener('click', () => this.scrollToBottom());
  }

  // 受信データはまとめて描画する（大量に届いても重くならないように）
  appendReceived(text) {
    this.#pending += text;
    if (!this.#timer) this.#timer = setTimeout(() => this.#flush(), FLUSH_MS);
  }

  sent(text) {
    this.#push('tx', `> ${text}`);
  }

  info(text) {
    this.#push('sys', `» ${text}`);
  }

  error(text) {
    this.#push('err', `✕ ${text}`);
  }

  clear() {
    this.#flush();
    this.#lines = [];
    this.#open = null;
    this.#el.replaceChildren();
    this.#updateJump();
  }

  setShowTime(on) {
    this.showTime = on;
    this.#el.classList.toggle('show-time', on);
  }

  scrollToBottom() {
    this.#el.scrollTop = this.#el.scrollHeight;
    this.#updateJump();
  }

  // 表示中の内容をテキストにする（時刻表示が ON なら時刻も含める）
  toText() {
    this.#flush();
    const rows = this.#lines.map((l) => (this.showTime ? `[${formatClock(l.time)}] ` : '') + l.text);
    return rows.length ? `${rows.join('\r\n')}\r\n` : '';
  }

  #push(kind, text) {
    this.#flush(); // 受信途中のデータを先に出して順序を保つ
    this.#stick(() => {
      this.#closeOpen();
      this.#addLine(kind, text);
      this.#trim();
    });
  }

  #flush() {
    clearTimeout(this.#timer);
    this.#timer = 0;
    if (!this.#pending) return;
    const text = this.#pending;
    this.#pending = '';
    this.#stick(() => {
      this.#process(text);
      this.#trim();
    });
  }

  #process(text) {
    const parts = text.split('\n');
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i].replace(/\r/g, '');
      if (part) {
        this.#open ??= this.#addLine('rx', '');
        this.#open.text += part;
        if (this.#open.text.length >= MAX_LINE_LENGTH) this.#closeOpen();
      }
      if (i < parts.length - 1) {
        this.#open ??= this.#addLine('rx', '');
        this.#closeOpen();
      }
    }
    if (this.#open) this.#open.msg.textContent = this.#open.text;
  }

  #closeOpen() {
    if (!this.#open) return;
    this.#open.msg.textContent = this.#open.text;
    this.#open = null;
  }

  #addLine(kind, text) {
    const time = new Date();
    const el = document.createElement('div');
    el.className = `line ${kind}`;
    const ts = document.createElement('span');
    ts.className = 'ts';
    ts.textContent = formatClock(time);
    const msg = document.createElement('span');
    msg.className = 'msg';
    msg.textContent = text;
    el.append(ts, msg);
    this.#el.append(el);
    const line = { kind, time, text, el, msg };
    this.#lines.push(line);
    return line;
  }

  #trim() {
    const excess = this.#lines.length - MAX_LINES;
    if (excess < 200) return;
    for (const line of this.#lines.splice(0, excess)) line.el.remove();
  }

  // 一番下を見ているときだけ、追加後も一番下に合わせる（上を見ている間は止める）
  #stick(fn) {
    const atBottom = this.#isAtBottom();
    fn();
    if (this.autoscroll && atBottom) this.#el.scrollTop = this.#el.scrollHeight;
    this.#updateJump();
  }

  #isAtBottom() {
    const el = this.#el;
    return el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_SLACK;
  }

  #updateJump() {
    this.#jump.hidden = this.#isAtBottom();
  }
}
