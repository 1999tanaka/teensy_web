// Intel HEX の解析と、HalfKay（Teensy のブートローダー）へ送るデータの作成
// 書き込みの規則は PJRC の teensy_loader_cli に合わせている

export const TEENSY41 = Object.freeze({
  name: 'Teensy 4.1',
  codeSize: 8126464, // 7936 KB
  blockSize: 1024,
  flashBase: 0x60000000, // Teensy 4.x の .hex は FlexSPI フラッシュのアドレスで書かれている
});

export class HexError extends Error {
  constructor(message) {
    super(message);
    this.name = 'HexError';
  }
}

export function parseIntelHex(text, board = TEENSY41) {
  const { codeSize, blockSize, flashBase } = board;
  const image = new Uint8Array(codeSize).fill(0xff);
  const used = new Uint8Array(codeSize / blockSize);
  let base = 0;
  let end = 0;
  let dataBytes = 0;
  let eof = false;

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length && !eof; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const where = `${i + 1}行目`;
    if (!/^:[0-9A-Fa-f]+$/.test(line) || line.length < 11 || line.length % 2 === 0) {
      throw new HexError(`${where}: Intel HEX の形式ではありません`);
    }

    const rec = new Uint8Array((line.length - 1) / 2);
    for (let j = 0; j < rec.length; j++) rec[j] = parseInt(line.substr(1 + j * 2, 2), 16);
    const len = rec[0];
    if (rec.length !== len + 5) throw new HexError(`${where}: レコードの長さが正しくありません`);
    let sum = 0;
    for (const b of rec) sum += b;
    if ((sum & 0xff) !== 0) throw new HexError(`${where}: チェックサムが一致しません（ファイルが壊れている可能性があります）`);

    const offset = (rec[1] << 8) | rec[2];
    const type = rec[3];
    const data = rec.subarray(4, 4 + len);

    switch (type) {
      case 0x00: { // データ
        if (len === 0) break;
        const start = base + offset - flashBase;
        if (start < 0 || start + len > codeSize) {
          const abs = (base + offset).toString(16).toUpperCase().padStart(8, '0');
          throw new HexError(`${where}: アドレス 0x${abs} は ${board.name} のフラッシュ範囲外です。${board.name} 用の .hex か確認してください`);
        }
        image.set(data, start);
        for (let b = Math.floor(start / blockSize); b <= Math.floor((start + len - 1) / blockSize); b++) used[b] = 1;
        end = Math.max(end, start + len);
        dataBytes += len;
        break;
      }
      case 0x01: // 終了
        eof = true;
        break;
      case 0x02: // 拡張セグメントアドレス
        if (len !== 2) throw new HexError(`${where}: アドレスレコードが正しくありません`);
        base = ((data[0] << 8) | data[1]) * 16;
        break;
      case 0x04: // 拡張リニアアドレス
        if (len !== 2) throw new HexError(`${where}: アドレスレコードが正しくありません`);
        base = ((data[0] << 8) | data[1]) * 0x10000;
        break;
      case 0x03:
      case 0x05: // 開始アドレス（書き込みには使わない）
        break;
      default:
        throw new HexError(`${where}: 未対応のレコード種別（${type}）です`);
    }
  }

  if (!eof) throw new HexError('終了レコードがありません。ファイルが途中で切れている可能性があります');
  if (dataBytes === 0) throw new HexError('書き込むデータがありません');

  const blocks = [];
  for (let addr = 0; addr < end; addr += blockSize) {
    // 先頭ブロックは消去のきっかけになるので必ず送る。それ以外は未使用・空白のブロックを飛ばす
    if (addr !== 0 && (!used[addr / blockSize] || isBlank(image, addr, blockSize))) continue;
    blocks.push(addr);
  }
  return { board, image, blocks, size: end, dataBytes };
}

function isBlank(image, addr, length) {
  for (let i = addr; i < addr + length; i++) {
    if (image[i] !== 0xff) return false;
  }
  return true;
}

// 書き込みレポート: 先頭 3 バイトがアドレス、64 バイト目からブロックのデータ
export function makeBlockReport(image, addr, blockSize) {
  const report = new Uint8Array(blockSize + 64);
  report[0] = addr & 0xff;
  report[1] = (addr >> 8) & 0xff;
  report[2] = (addr >> 16) & 0xff;
  report.set(image.subarray(addr, addr + blockSize), 64);
  return report;
}

// 書き込み後に新しいプログラムで起動させるレポート
export function makeBootReport(blockSize) {
  const report = new Uint8Array(blockSize + 64);
  report[0] = 0xff;
  report[1] = 0xff;
  report[2] = 0xff;
  return report;
}
