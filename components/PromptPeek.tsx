"use client";

import { useState } from "react";

/**
 * 모델에 실제로 들어가는 원문을 미리 본다.
 *
 * 로컬에서 돌아가니 외부로 나가는 건 없지만, **무엇이 모델에 들어가는지는 보여야 한다.**
 * 담당자 메모에는 기관 평가나 지연 사유 같은 민감한 문장이 섞이기 때문이다.
 */
export default function PromptPeek({ label = "모델에 보낼 원문 보기", text }: { label?: string; text: string }) {
  const [open, setOpen] = useState(false);
  if (!text) return null;

  return (
    <div className="peek">
      <button className="peek__toggle" onClick={() => setOpen((current) => !current)} aria-expanded={open}>
        {open ? "▾" : "▸"} {label} ({text.length.toLocaleString()}자)
      </button>
      {open && <pre className="peek__body">{text}</pre>}
    </div>
  );
}
