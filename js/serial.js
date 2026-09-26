// Web Serial による Teensy との通信（受信・送信・自動再接続・ブートローダーへの切り替え）
import { sleep, withTimeout } from './util.js';

export const TEENSY_VID = 0x16c0;
const BAUD_RATE = 115200; // Teensy の USB シリアルでは通信速度に影響しない
const REBOOT_BAUD_RATE = 134; // この値を設定すると Teensy はブートローダーに入る

// イベント: status（状態が変わった）, data（受信文字列）, ports（ポートの増減）, lost（予期しない切断）
export class SerialManager extends EventTarget {
  port = null;
  status = 'disconnected'; // disconnected | connected | reconnecting
  wantConnected = false;
  #reader = null;
  #readLoop = null;
  #closing = false;
  #reconnectToken = 0;
  #lastInfo = null;
  #sendQueue = Promise.resolve();
  #encoder = new TextEncoder();

  constructor() {
    super();
    navigator.serial.addEventListener('connect', () => this.#emit('ports'));
    navigator.serial.addEventListener('disconnect', () => this.#emit('ports'));
  }

  getPorts() {
    return navigator.serial.getPorts();
  }

  // ブラウザのポート選択ダイアログを出す。クリックなどのユーザー操作の中で呼ぶこと
  requestPort() {
    return navigator.serial.requestPort({ filters: [{ usbVendorId: TEENSY_VID }] });
  }

  async connect(port) {
    this.cancelReconnect();
    await this.#close();
    this.wantConnected = true;
    try {
      await port.open({ baudRate: BAUD_RATE });
    } catch (e) {
      this.wantConnected = false;
      this.#setStatus('disconnected');
      throw e;
    }
    this.#attach(port);
  }

  async disconnect() {
    this.wantConnected = false;
    this.cancelReconnect();
    await this.#close();
    this.#setStatus('disconnected');
  }

  send(text) {
    const port = this.port;
    if (!port?.writable || this.status !== 'connected') {
      return Promise.reject(new Error('シリアルが接続されていません'));
    }
    const data = this.#encoder.encode(text);
    const job = this.#sendQueue.catch(() => {}).then(async () => {
      const writer = port.writable.getWriter();
      try {
        await writer.write(data);
      } finally {
        writer.releaseLock();
      }
    });
    this.#sendQueue = job;
    return job;
  }

  // 書き込みの前に呼ぶ。Teensy をブートローダーに切り替える操作ができたら true
  async rebootToBootloader() {
    this.cancelReconnect();
    this.wantConnected = false;
    let port = this.port;
    if (port) await this.#close();
    else port = await this.#findTeensyPort();
    this.#setStatus('disconnected');
    if (!port) return false;
    try {
      await port.open({ baudRate: REBOOT_BAUD_RATE });
    } catch {
      return false;
    }
    await sleep(100);
    try {
      await withTimeout(port.close(), 1000);
    } catch {
      // 再起動で切断済み
    }
    return true;
  }

  // 接続を閉じる（自動再接続もしない）
  async release() {
    this.cancelReconnect();
    this.wantConnected = false;
    await this.#close();
    this.#setStatus('disconnected');
  }

  // Teensy のポートが現れるまで待って接続する。timeoutMs = 0 なら無期限
  // 戻り値: 'connected' | 'timeout' | 'cancelled'
  async reconnect(timeoutMs = 0) {
    const token = ++this.#reconnectToken;
    this.wantConnected = true;
    this.#setStatus('reconnecting');
    const start = Date.now();
    while (token === this.#reconnectToken) {
      if (timeoutMs && Date.now() - start > timeoutMs) {
        this.wantConnected = false;
        this.#setStatus('disconnected');
        return 'timeout';
      }
      const port = await this.#findTeensyPort();
      if (port && token === this.#reconnectToken) {
        let opened = false;
        try {
          await port.open({ baudRate: BAUD_RATE });
          opened = true;
        } catch {
          // 起動直後はまだ開けないことがあるので再試行する
        }
        if (opened) {
          if (token !== this.#reconnectToken) {
            try { await port.close(); } catch { /* 無視 */ }
            return 'cancelled';
          }
          this.#attach(port);
          return 'connected';
        }
      }
      await sleep(500);
    }
    return 'cancelled';
  }

  cancelReconnect() {
    this.#reconnectToken++;
    if (this.status === 'reconnecting') this.#setStatus('disconnected');
  }

  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  #setStatus(status) {
    if (this.status === status) return;
    this.status = status;
    this.#emit('status', status);
  }

  #attach(port) {
    this.port = port;
    this.#lastInfo = port.getInfo();
    this.#setStatus('connected');
    this.#readLoop = this.#read(port);
  }

  async #read(port) {
    const decoder = new TextDecoder();
    while (port.readable && this.port === port && !this.#closing) {
      const reader = port.readable.getReader();
      this.#reader = reader;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value?.length) this.#emit('data', decoder.decode(value, { stream: true }));
        }
      } catch {
        // 通信エラー。切断された場合は readable が null になりループを抜ける
      } finally {
        reader.releaseLock();
        this.#reader = null;
      }
    }
    if (this.port === port && !this.#closing) await this.#lost(port);
  }

  async #lost(port) {
    this.port = null;
    try {
      await port.close();
    } catch {
      // 切断済み
    }
    this.#emit('lost');
    if (this.wantConnected) this.reconnect();
    else this.#setStatus('disconnected');
  }

  async #close() {
    const port = this.port;
    if (!port) return;
    this.#closing = true;
    try {
      try { await this.#reader?.cancel(); } catch { /* 無視 */ }
      try { await withTimeout(this.#readLoop ?? Promise.resolve(), 2000); } catch { /* 無視 */ }
      try { await withTimeout(this.#sendQueue.catch(() => {}), 2000); } catch { /* 無視 */ }
      try { await withTimeout(port.close(), 2000); } catch { /* 無視 */ }
    } finally {
      this.port = null;
      this.#readLoop = null;
      this.#closing = false;
    }
  }

  async #findTeensyPort() {
    const ports = (await navigator.serial.getPorts()).filter((p) => p.getInfo().usbVendorId === TEENSY_VID);
    const pid = this.#lastInfo?.usbProductId;
    return ports.find((p) => p.getInfo().usbProductId === pid) ?? ports[0] ?? null;
  }
}
