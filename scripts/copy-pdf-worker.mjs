/**
 * pdf.js 워커를 public/으로 복사한다.
 *
 * pdf.js는 workerSrc가 반드시 지정돼야 동작한다. 번들러가 알아서 처리해 주길
 * 기대하면 dev/prod에서 다르게 깨지기 쉬워서, 정해진 경로에 파일을 두고
 * 그 경로를 가리키게 한다. 저장소에는 넣지 않고 설치 시 만들어 쓴다.
 */
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const src = resolve(dirname(require.resolve("pdfjs-dist/package.json")), "build/pdf.worker.min.mjs");
const out = resolve(here, "../public/pdf.worker.min.mjs");

mkdirSync(dirname(out), { recursive: true });
copyFileSync(src, out);
console.log("pdf.js 워커를 public/pdf.worker.min.mjs 로 복사했습니다.");
