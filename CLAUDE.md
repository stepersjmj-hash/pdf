# PDF 편집기 (pdf)

브라우저에서 PDF를 열고 편집하는 100% 클라이언트 사이드 웹 앱.
PDF24 스타일, 한국어 UI. 배포: https://stepersjmj-hash.github.io/pdf/

## 구성

- `index.html` — 전체 레이아웃 (상단 바, 툴바, 검색바, 섬네일 사이드바, 뷰어)
- `src/main.js` — 앱 로직 전부 (상태, 렌더링, 페이지 편집, 주석, 검색, 인쇄, 저장)
- `src/style.css` — 스타일 (인쇄용 `@media print` 포함)
- `public/fonts/NotoSansKR-Regular.otf` — 한글 텍스트 주석용 (저장 시 서브셋 임베딩)
- 스택: Vite + pdfjs-dist(렌더링·검색) + pdf-lib/@pdf-lib/fontkit(편집·저장)

## 반복 작업 절차

### 개발·테스트
1. `npm run dev` (포트 5173). 브라우저 자동 테스트는 `window.__pdfApp` 훅 사용
   (state, buildPdf, rotatePage, deletePage, runSearch, printPdf, pdfjsLib 노출).
2. 테스트 PDF 생성: pdf-lib로 node 스크립트 한 줄 (git 히스토리의 test.pdf 생성 스크립트 참고).
   암호 PDF는 `python + pypdf` 로 `w.encrypt(user_password='1234', algorithm='AES-256')`.
3. 파일 열기 시뮬레이션: `DataTransfer` + `document.dispatchEvent(new DragEvent('drop', ...))`.
   테스트 파일은 `public/` 에 잠깐 넣고 fetch → **커밋 전에 반드시 삭제**.

### 배포
`main` 에 push 하면 GitHub Actions(`.github/workflows/deploy.yml`)가 자동 빌드·배포.
Pages 소스는 "GitHub Actions" 방식 (브랜치 배포 아님 — 되돌리면 소스가 그대로 서빙되어 깨짐).
배포 확인: `curl https://stepersjmj-hash.github.io/pdf/` 로 `assets/index-*.js` 참조 여부 확인.

## 함정과 해결책

- **pdf.js 렌더가 영원히 pending**: 기본 렌더는 requestAnimationFrame 의존 →
  숨겨진 브라우저 패널/백그라운드 탭에서 멈춤. 모든 `page.render()` 에 `intent: 'print'` 유지할 것.
- **주석 좌표계**: 주석은 "회전 반영된 표시 화면" 기준 비율(fx, fy)로 저장.
  저장 시 `displayToPdf()` 가 회전값(0/90/180/270)별로 PDF 좌하단 원점 좌표로 역변환.
  페이지 회전 시 `transformAnnosForRotation()` 이 기존 주석도 함께 회전.
- **텍스트 주석 편집**: overlay mousedown에서 `e.preventDefault()` 필수
  (기본 포커스 이동이 contenteditable을 즉시 blur시켜 상자가 사라짐).
  편집 종료(finish)는 전체 재렌더 대신 노드 유지 방식 — 더블클릭 체인 끊김 방지.
- **암호 보호 PDF**: pdf.js는 암호로 열 수 있지만 pdf-lib는 복호화 불가 →
  `buildPdf()` 가 해당 소스만 pdf.js 렌더 → PNG 삽입으로 폴백 (`rasterizePage`).
  판단 기준: `getLibDoc()` 실패 또는 `libDoc.isEncrypted`.
- **Vite base**: `base: './'` (하위 경로 /pdf/ 배포). 절대 경로 fetch 금지 —
  폰트는 `import.meta.env.BASE_URL + 'fonts/...'`.
- **gh CLI 없음** (이 PC의 Git Bash 기준): GitHub API는 `curl https://api.github.com/...` 로.

## 관례

- 커밋 메시지: 한국어, 기능 요약 한 줄 + 필요시 상세 불릿.
- UI 문구: 한국어, 토스트로 피드백 (`toast()`).
- 기능 추가 시 README.md 기능 목록도 함께 갱신 (사용자 관점).
