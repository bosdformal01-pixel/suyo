// ============================================================
//  수요미식회 사이트 설정 파일
//  README.md의 순서대로 아래 값을 채워 넣으세요.
// ============================================================
window.SUYO_CONFIG = {
  // 1) Firebase 콘솔 > 프로젝트 설정 > 내 앱(웹) 에서 복사한 값
  firebase: {
    apiKey: "AIzaSyC0b5Gfn36VHug9q-TtembIOSZLuIHhMDs",
    authDomain: "suyo-misikhoe-bf6a0.firebaseapp.com",
    projectId: "suyo-misikhoe-bf6a0",
    storageBucket: "suyo-misikhoe-bf6a0.firebasestorage.app",
    messagingSenderId: "1080988892508",
    appId: "1:1080988892508:web:112f44d9f98cbb79de9599"
  },

  // 2) 카카오 디벨로퍼스 > 내 애플리케이션 > 앱 키 > "JavaScript 키"
  kakaoJsKey: "69c063e42ec6b7d2ed5ec0cf82e8f576",

  // 3) 맛집 지도를 처음 열었을 때 보여줄 위치 (학교 근처 좌표로 바꾸면 좋아요)
  //    네이버/카카오 지도에서 학교를 검색한 뒤 좌표를 찾아 넣으면 됩니다.
  //    지금 값: 울산 현대고등학교 (울산 동구 봉수로 455)
  mapCenter: { lat: 35.5252135, lng: 129.4216283 },

  // 4) 모임 기본 시작 시간 (이번 주 계획에 처음 표시되는 시간)
  defaultTime: "16:30",

  // 5) 출발지 (학교 마치고 출발하는 곳) — 가는 법(버스·택시) 계산 기준
  school: { name: "현대고등학교", lat: 35.5252135, lng: 129.4216283 },

  // 6) ODsay LAB 대중교통 API 키 (버스 노선 안내용, lab.odsay.com 에서 무료 발급)
  //    비워 두면 버스 정보 대신 택시 추정 요금과 카카오맵 길찾기 링크만 보여요.
  //    ※ 무료(Basic)는 하루 30번까지 — 사이트는 식당마다 한 번만 찾고 저장해서 써요.
  odsayKey: "pFFR0Q5DCWb+4zEO66S9/A",

  // 7) 택시 요금 (울산, 2025.3.10 인상분 기준) — 요금이 바뀌면 여기만 고치면 돼요
  taxi: { base: 4500, baseMeters: 2000, perMeters: 125, perWon: 100, perSeconds: 30 }
};
