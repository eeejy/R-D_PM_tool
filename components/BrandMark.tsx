"use client";

import { useState } from "react";
import Mascot from "./Mascot";

/**
 * 브랜드 아이콘.
 *
 * `public/brand-icon.png`이 있으면 그 이미지를 그대로 쓴다 — 원본을 재디자인하지 않고
 * 크기와 배치만 맞춘다. 파일이 없으면 벡터 마스코트로 떨어진다.
 * 어느 쪽이든 정사각 박스 안에서 object-fit으로 비율을 지킨다.
 */
export default function BrandMark({ size = 42 }: { size?: number }) {
  const [hasImage, setHasImage] = useState(true);

  return (
    <span className="brandmark" style={{ width: size, height: size }}>
      {hasImage ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src="/brand-icon.png"
          alt=""
          className="brandmark__img"
          onError={() => setHasImage(false)}
        />
      ) : (
        <Mascot size={size} />
      )}
    </span>
  );
}
