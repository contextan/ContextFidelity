# Colosseum 제출 준비 체크리스트

기준일: 2026-10-08. 현재 제품 및 검증 현황은 [프로젝트 정리](project-summary.md)를 기준으로 합니다.

## 제출 판단

작동하는 프로토타입과 핵심 흐름 검증은 갖춰졌습니다. 제출 전에 가장 큰 차단 요소는 심사위원이 외부에서 열 수 있는 HTTPS 데모와 GitHub 저장소 접근성입니다. 두 항목을 해결한 다음, 영상과 제출 폼을 마무리해야 합니다.

Colosseum의 2026 Crypto World’s Fair는 모든 블록체인 생태계의 프로젝트를 받으며, 제출 마감일은 2026년 10월 12일입니다. 제출 안내에는 제품 설명, 통합한 체인·도구, 팀 배경과 위치, 로고, GitHub 저장소, 발표 영상, 제품 데모 영상, GTM·수요 검증 계획이 포함됩니다. 세부 항목과 제출 시간은 포털에서 최종 확인하세요. [공식 해커톤 안내 및 FAQ](https://colosseum.com/hackathon?year=fall2026), [Crypto World’s Fair](https://colosseum.com/worldsfair)

## 먼저 끝낼 일

### P0 — 심사위원이 실제로 접근할 수 있게 만들기

- [ ] GitHub 저장소가 공개 상태인지 확인하고, README 첫 화면에서 제품과 실행 방법을 바로 이해할 수 있게 합니다.
- [ ] 저장소에 개인 대화 DB, OAuth 자격 증명, API 키, 로컬 로그가 포함되지 않았는지 마지막으로 확인합니다.
- [ ] Cloudflare Tunnel과 영구 저장소를 연결해 HTTPS 공개 데모를 엽니다.
- [ ] 완전히 새 브라우저 세션으로 방문자 데이터 격리, 쿠키, 새로고침·재시작 후 동작을 확인합니다.
- [ ] 심사위원이 API 키를 넣지 않고 흐름을 볼 수 있는 데모 경로를 준비합니다. 데모 데이터는 고정 시연임을 명확히 표시합니다.

### P1 — 제품의 차이를 짧게 증명하기

- [ ] 하나의 대화에서 서로 다른 질문 주제 2~3개를 연속 입력합니다.
- [ ] 각 답변 아래에서 자동으로 파악한 주제와 실제 모델 요청에 포함된 컨텍스트 영수증을 확인합니다.
- [ ] 영수증에서 원문 근거를 열고, 주제 전환 뒤 이전 주제 맥락이 섞이지 않는지 보여줍니다.
- [ ] `/ko/`에서 한국어 질문을 보내고 자동 등록된 컨텍스트의 내용·원문이 예상한 언어로 보존되는지 확인합니다.
- [ ] 답변 기록에서 생성, 원문 검증, 필요한 경우 1회 교정, 재검증의 실제 요청 내용을 비교합니다.
- [ ] 데모에서 자동 컨텍스트 등록은 보여주되, 모델 제안이 가설로 표시되는 점도 한 번 보여줍니다.

## 영상은 두 종류로 준비

주간 업데이트 영상과 최종 제품 제출 영상은 목적이 다릅니다. 사용자가 확인한 Week 4 입력란은 주간 진행 영상 링크이며, 화면에는 10월 9일 오전 8시 PDT 오픈, 10월 12일 오전 8시 PDT 마감으로 표시됐습니다. 한국 시간으로는 각각 10월 10일 오전 0시, 10월 13일 오전 0시입니다. 주간 업데이트는 지난주에 만든 것과 배운 점, 다음 작업을 짧게 말합니다. 최종 제품 제출 폼에는 별도의 발표 영상과 제품 데모 영상이 요구됩니다. 주간 업데이트는 약 1분, 발표 영상은 2~3분, 제품 데모는 3분 이내로 준비하는 것이 안내와 맞습니다. 제출 포털의 최종 마감 시각을 다시 확인하세요. [Colosseum FAQ](https://colosseum.com/hackathon?year=fall2026), [제출 영상 워크숍 가이드](https://blog.colosseum.com/perfecting-your-hackathon-submission/)

### 발표 영상: 왜 필요한가

1. 대상 사용자와 반복되는 문제: 여러 프로젝트·주제를 넘나드는 장기 AI 대화에서 맥락이 뒤섞이거나 이미 정정한 내용이 되살아납니다.
2. ContextPulse의 접근: 질문별 자동 주제 파악, 필요한 맥락만 요청에 포함, 답변별 실제 전달 영수증과 원문 추적.
3. 초기 검증: 실제 모델로 주제 전환 6턴을 확인했고, 자동 테스트 53개가 통과했습니다. 이는 제품 흐름 검증이지 사용자 수요나 정확도 벤치마크는 아닙니다.
4. 다음 검증: 암호화폐 제품을 만드는 개발자·팀에게 사용성 인터뷰와 반복 사용 테스트를 진행하고, 맥락 혼입 수정 시간과 재설명 횟수가 줄어드는지 측정합니다. 현재 전달된 진행현황에는 인터뷰 결과가 포함되어 있지 않으므로, 이미 진행했다면 인원·의견·반영한 변경을 제출 자료에 기록합니다.
5. 팀의 관련 경험, 이 문제를 선택한 이유, 다음 제품 단계와 배포 계획.

### 제품 데모 영상: 어떻게 동작하는가

1. 공개 데모에 들어가 대화 화면을 엽니다.
2. Product → Design → Submission처럼 주제가 바뀌는 질문을 이어서 입력합니다.
3. 답변 밑의 컨텍스트 영수증을 열어 해당 답변의 실제 모델 입력과 원문 출처를 보여줍니다.
4. 자동 컨텍스트 목록에서 새로 파악한 항목과 가설 구분을 보여줍니다.
5. 답변 기록에서 한 답변의 생성·검증·교정 기록을 열어 호출 입력 비교를 보여주고 마칩니다.

실제 OAuth 인증정보, 사용자 대화, API 키가 녹화 화면에 나오지 않도록 별도 데모 계정과 데이터로 녹화합니다. 공개 링크는 로그아웃 상태에서 재생되는지 확인합니다.

## 제출 폼 초안

아래 영문 설명은 500자 이내로 작성했습니다. 카테고리 이름은 포털의 실제 선택지 중 가장 가까운 항목을 선택합니다.

**Product name:** ContextPulse

**Category:** AI / Developer Tools (포털 선택지에 맞춰 선택)

**Brief description:**

> ContextPulse is a local-first chat workspace that automatically selects project context for each question and shows the exact context sent with every answer. It keeps topics separate, captures useful context from conversation, and preserves source-linked call receipts so builders can inspect what was sent and catch cross-topic leakage. It works with ChatGPT OAuth, OpenAI API, and local Ollama models.

**Chains and tools:**

> No blockchain integration is implemented in this prototype. ContextPulse integrates ChatGPT OAuth, OpenAI-compatible model APIs, local Ollama models, and SQLite. The initial target users are crypto product teams that use AI throughout research, design, and shipping.

체인 연동을 구현하지 않았다면 그대로 밝힙니다. 공식 FAQ는 모든 생태계의 프로젝트가 상금 대상이라고 안내하지만, 심사는 제품 실행·시장·실행 가능성과 팀의 통찰도 평가합니다. 따라서 암호화폐 팀을 첫 사용자로 삼는 이유와 실제 사용자 피드백을 확보하는 것이 중요합니다. [공식 FAQ 및 심사 기준](https://colosseum.com/hackathon?year=fall2026)

## 공개 전 마지막 확인

- [ ] 공개 URL에서 영어 기본 화면과 `/ko/` 한국어 화면이 모두 열립니다.
- [ ] 한국어 채팅에서 자동 파악한 질문과 컨텍스트가 임의로 영어로 바뀌지 않습니다.
- [ ] 처음 온 사용자가 빈 화면이나 개발용 테스트 기록을 보지 않습니다.
- [ ] 모델 연결을 못 해도 안내된 데모 경로에서 핵심 흐름을 볼 수 있습니다.
- [ ] 사용된 컨텍스트 영수증이 실제 저장된 요청 입력과 일치하고 원문 근거가 열립니다.
- [ ] hosted mode에서 방문자 간 대화와 API 키가 분리됩니다.
- [ ] 제출에 기재한 GitHub 링크와 영상 링크가 로그아웃 상태에서도 열립니다.
- [ ] 기존 코드·개발 이력과 해커톤 기간에 새로 만든 작업을 사실대로 구분합니다. Colosseum은 해커톤 이전 코드 사용을 허용하지만, 관련 과거 개발을 공개하도록 안내합니다.
- [ ] 제출 폼에서 팀원, 위치, 로고, GTM, 수요 검증, 향후 배포 계획을 빠짐없이 채웁니다.

## 현재 남은 차단 요소

1. Cloudflare 공개 터널·도메인·HTTPS가 아직 연결되지 않았습니다.
2. 실제 도메인에서 Secure cookie와 방문자 격리를 검증하지 않았습니다.
3. GitHub CLI가 이 환경에서 인증되어 있지 않아 원격 저장소 공개·푸시 여부를 확인해야 합니다.
4. 전달된 진행현황에 사용자 인터뷰와 수요 검증 결과가 없습니다. 이미 진행한 검증이 있다면 근거를 추가하고, 자동 테스트 통과 수를 시장 검증으로 표현하지 않습니다.
5. 임베딩 검색, 긴 기록 전체 검색, 외부 대화 가져오기·삭제, 독립된 검증 모델은 후속 범위입니다. 마감 전 범위를 넓히기보다 핵심 흐름과 공개 접근성을 완성합니다.
