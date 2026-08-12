import { redirect } from "next/navigation";

/**
 * `/rfp?q=실증` 진입점.
 *
 * 앱은 한 화면에서 뷰를 바꾸는 구조라, 여기서는 검색어를 들고 본 화면으로 넘긴다.
 * 업무트리나 WBS에서 "RFP에서 근거 찾기"를 붙일 때 이 주소만 알면 된다.
 */
export default async function RfpEntry({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  redirect(`/?view=rfp${q ? `&q=${encodeURIComponent(q)}` : ""}`);
}
