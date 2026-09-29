// コマンドの変数（{ } で囲んだ部分）の解析
// 例: "Tx ch1 {03} {28} {00}" → 固定の文字 "Tx ch1 " と、初期値 03・28・00 の入力欄
// {{ と }} は { と } そのものを表す。閉じていない { や、単独の } はそのまま送る

export function parseCommand(command) {
  const parts = [];
  let text = '';
  const flushText = () => {
    if (text) parts.push({ type: 'text', text });
    text = '';
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if ((ch === '{' || ch === '}') && command[i + 1] === ch) {
      text += ch;
      i++;
      continue;
    }
    if (ch === '{') {
      const end = command.indexOf('}', i + 1);
      const inner = end < 0 ? null : command.slice(i + 1, end);
      if (inner !== null && !inner.includes('{')) {
        flushText();
        parts.push({ type: 'var', value: inner.trim() });
        i = end;
        continue;
      }
    }
    text += ch;
  }
  flushText();
  return parts;
}

export const variablesOf = (parts) => parts.filter((part) => part.type === 'var');

export const hasVariables = (parts) => parts.some((part) => part.type === 'var');

// 入力欄の値を順番に当てはめて、送るコマンドを作る
export function buildCommand(parts, values) {
  let index = 0;
  return parts.map((part) => (part.type === 'var' ? values[index++] ?? '' : part.text)).join('');
}
