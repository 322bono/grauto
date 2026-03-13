import Link from "next/link";

export default function NotFound() {
  return (
    <main className="shell" style={{ minHeight: "100vh", display: "grid", placeItems: "center" }}>
      <section className="card pad stack" style={{ width: "min(520px, 100%)", textAlign: "center" }}>
        <span className="status warn" style={{ justifySelf: "center" }}>
          404
        </span>
        <h1 className="section-title" style={{ fontSize: "2rem" }}>
          페이지를 찾을 수 없습니다
        </h1>
        <p className="subtle" style={{ margin: 0, lineHeight: 1.7 }}>
          요청하신 페이지가 없거나 이동되었어요. 홈으로 돌아가서 다시 시작해 주세요.
        </p>
        <div className="button-row" style={{ justifyContent: "center" }}>
          <Link className="cta" href="/">
            홈으로 이동
          </Link>
        </div>
      </section>
    </main>
  );
}
