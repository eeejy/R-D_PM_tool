/**
 * R&D Flow 마스코트(물개).
 *
 * PNG 대신 SVG로 둔 이유: 16px 파비콘에서도 선명하고, 선 색이 currentColor라
 * 라이트/다크 어디서든 주변 색을 따라간다. 얼굴은 표면색을 쓰므로 다크 테마에서
 * 흰 판이 떠 보이지 않는다.
 *
 * 머리와 오른쪽 지느러미는 하나의 닫힌 패스다. 따로 그리면 둘 사이에 선이 남아
 * 지느러미가 손잡이처럼 분리돼 보인다.
 */
export default function Mascot({ size = 28, title }: { size?: number; title?: string }) {
  const face = "var(--surface, #fff)";
  return (
    <svg
      width={size}
      height={size}
      viewBox="11 10 47 47"
      fill="none"
      role={title ? "img" : "presentation"}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      {/* 몸통 — 머리 뒤로 깔린다 */}
      <rect x="13" y="43.4" width="36" height="9.6" rx="4.8" fill="currentColor" />

      {/* 머리 + 지느러미 (한 줄기) */}
      <path
        d="M45.19 42.4A18.3 18.3 0 1 1 47.88 27.16C53 26.5 56.3 30 56.3 35c0 4.5-5.8 7.8-11.11 7.4Z"
        fill={face}
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinejoin="round"
      />

      {/* 눈 */}
      <ellipse cx="21.2" cy="32.4" rx="1.7" ry="2.3" fill="currentColor" />
      <ellipse cx="40.2" cy="32.4" rx="1.7" ry="2.3" fill="currentColor" />

      {/* 주둥이 — 두 갈래 볼과 코 */}
      <circle cx="27.1" cy="37.6" r="3.4" fill={face} stroke="currentColor" strokeWidth="1.9" />
      <circle cx="33.8" cy="37.6" r="3.4" fill={face} stroke="currentColor" strokeWidth="1.9" />
      <path d="M30.5 33.2v3.4" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
      <circle cx="30.5" cy="31.6" r="1.7" fill="currentColor" />

      {/* 왼쪽 볼의 수염 */}
      <path
        d="m16.4 38 1.6 1.7 2.3-2.7"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
