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
  kakaoJsKey: "",

  // 3) 맛집 지도를 처음 열었을 때 보여줄 위치 (학교 근처 좌표로 바꾸면 좋아요)
  //    네이버/카카오 지도에서 학교를 검색한 뒤 좌표를 찾아 넣으면 됩니다.
  //    지금 값: 서울시청
  mapCenter: { lat: 37.5663, lng: 126.9779 },

  // 4) 모임 기본 시작 시간 (이번 주 계획에 처음 표시되는 시간)
  defaultTime: "16:30"
};
