import { readFileSync } from 'node:fs';
const bytes = new Uint8Array(readFileSync(process.argv[2]));
const words: number[] = []; let cur = 12;
while (bytes[cur + 5] === 0x78) { const pl = bytes.slice(cur + 6, cur + 200); const n = (pl[0] & 0x7f) | ((pl[1] & 0x7f) << 7); for (let i = 0; i < n; i++) { const o = 2 + i * 3; words.push((pl[o] & 0x7f) | ((pl[o + 1] & 0x7f) << 7) | ((pl[o + 2] & 0x03) << 14)); } cur += 202; }
console.log('total', words.length, 'header', Array.from(bytes.slice(6, 10)));
console.log('name', words.slice(1, 40).map((w) => (w >= 32 && w < 127 ? String.fromCharCode(w) : `[${w}]`)).join(''));
for (let i = 0; i < 260; i += 20) console.log(String(i).padStart(4), words.slice(i, i + 20).join(' '));
