// WebHID で HalfKay（Teensy のブートローダー）に書き込む
import { makeBlockReport, makeBootReport } from './hex.js';
import { sleep, withTimeout, TimeoutError } from './util.js';

export const HALFKAY_FILTER = Object.freeze({ vendorId: 0x16c0, productId: 0x0478 });

// HalfKay の HID usage（usage page 0xFF9C）でボードの種類が分かる
const MODELS = { 0x24: 'Teensy 4.0', 0x25: 'Teensy 4.1', 0x26: 'Teensy MicroMod' };

const isHalfKay = (d) => d.vendorId === HALFKAY_FILTER.vendorId && d.productId === HALFKAY_FILTER.productId;

// 許可済みで、今つながっている HalfKay を探す
export async function findHalfKay() {
  const devices = await navigator.hid.getDevices();
  return devices.find(isHalfKay) ?? null;
}

// ブラウザのデバイス選択ダイアログを出す。クリックなどのユーザー操作の中で呼ぶこと
export async function requestHalfKay() {
  const devices = await navigator.hid.requestDevice({ filters: [HALFKAY_FILTER] });
  return devices.find(isHalfKay) ?? null;
}

export function detectModel(device) {
  for (const c of device.collections ?? []) {
    if (c.usagePage === 0xff9c && MODELS[c.usage]) return MODELS[c.usage];
  }
  return null;
}

export async function flashHalfKay(device, hex, onProgress) {
  const { image, blocks, board } = hex;
  if (!device.opened) await device.open();
  try {
    for (let i = 0; i < blocks.length; i++) {
      const report = makeBlockReport(image, blocks[i], board.blockSize);
      // 最初のブロックで消去が走るため、再試行の猶予を長めにとる
      await sendReport(device, report, i === 0 ? 10000 : 3000);
      onProgress?.(i + 1, blocks.length);
    }
    try {
      await withTimeout(device.sendReport(0, makeBootReport(board.blockSize)), 2000);
    } catch {
      // 再起動で切断されると失敗扱いになることがあるので無視する
    }
  } finally {
    try {
      await device.close();
    } catch {
      // 切断済み
    }
  }
}

// HalfKay は処理中に送信を受け付けないことがあるので、猶予時間内は再試行する
async function sendReport(device, report, retryMs) {
  const start = performance.now();
  for (;;) {
    try {
      await withTimeout(device.sendReport(0, report), 60000, 'Teensy から応答がありません');
      return;
    } catch (e) {
      if (e instanceof TimeoutError || performance.now() - start > retryMs) throw e;
      await sleep(10);
    }
  }
}
