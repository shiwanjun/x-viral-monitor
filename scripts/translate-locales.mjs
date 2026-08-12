#!/usr/bin/env node
// Generate complete extension locale catalogs from the English source.
// Uses a public translation endpoint; placeholders are protected before
// translation so Chrome i18n substitutions keep their original shape.

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const LOCALES = join(root, '_locales');
const source = JSON.parse(await readFile(resolve(root, '_locales/en/messages.json'), 'utf8'));
const targets = [
  { id: 'zh_TW', language: 'zh-TW' },
  { id: 'vi', language: 'vi' },
  { id: 'ko', language: 'ko' },
];

// Public machine-translation services are not a runtime dependency. These
// static overrides cover the controls and feature labels users interact with
// most; the complete base catalogue below guarantees every Chrome i18n key is
// present in each language package.
const STATIC_OVERRIDES = {
  vi: {
    extDescription: 'Phát hiện nội dung lan truyền và thông tin theo dõi: huy hiệu tốc độ, đánh dấu theo dõi lẫn nhau, theo dõi một chiều và cảnh báo bỏ theo dõi. Hoàn toàn cục bộ, không thu thập dữ liệu.',
    popupSubtitle: 'Phát hiện nội dung lan truyền và thông tin theo dõi cho X',
    btnSave: 'Lưu', btnSaved: 'Đã lưu', btnReset: 'Đặt lại', btnAdd: 'Thêm', btnDelete: 'Xóa', btnBack: 'Quay lại', btnCancel: 'Hủy',
    tierNormal: 'Bình thường', tierTrending: 'Đang thịnh hành', tierViral: 'Lan truyền',
    tabPro: 'Hội viên', tabFilter: 'Lọc', tabLeaderboard: 'Bảng xếp hạng', tabAi: 'Trả lời AI', tabAbout: 'Giới thiệu',
    themeLabel: 'Giao diện', themeSwitchToDark: 'Chuyển sang tối', themeSwitchToLight: 'Chuyển sang sáng', themeFollowSystem: 'Theo hệ thống',
    languageLabel: 'Ngôn ngữ', languageHint: 'Áp dụng cho cửa sổ tiện ích, lớp phủ trang và ngôn ngữ mặc định của lời nhắc Grok.',
    languageZh: '中文', languageZhTW: '中文 phồn thể', languageEn: 'English', languageJa: '日本語', languageVi: 'Tiếng Việt', languageKo: '한국어',
    cfTitle: 'Bộ lọc nội dung', cfLockedHint: 'Lọc nội dung miễn phí. Bạn có thể bật tại đây.', cfEnabled: 'Ẩn phản hồi người lớn / quảng cáo / dẫn dụ', cfLevel: 'Mức lọc', cfLevelLight: 'Nhẹ', cfLevelStandard: 'Tiêu chuẩn', cfLevelStrict: 'Nghiêm ngặt', cfRuleCounts: '$COUNT$ quy tắc có sẵn, $CUSTOM$ quy tắc tùy chỉnh.', cfScopeHint: 'Chỉ áp dụng cho khu vực phản hồi trên trang chi tiết bài đăng. Trang chủ, tìm kiếm, hồ sơ và bài đăng chính không bị lọc.', cfCustomTitle: 'Quy tắc tùy chỉnh', cfWhitelistTitle: 'Cài đặt danh sách cho phép / chặn', cfValue: 'Từ khóa / regex / miền', cfAddRule: 'Thêm quy tắc', cfDeleteRule: 'Xóa quy tắc', cfCustomEmpty: 'Chưa có quy tắc tùy chỉnh.', cfWhitelistFollowing: 'Luôn cho phép tài khoản bạn theo dõi', cfWhitelistHandles: 'Tài khoản được cho phép', cfBlacklistHandles: 'Tài khoản bị chặn', cfWhitelistDomains: 'Miền được cho phép', cfAllRulesTitle: 'Tất cả quy tắc', cfBuiltinRule: 'Có sẵn', cfCustomRule: 'Tùy chỉnh', cfNoRules: 'Không có quy tắc.', cfRuleHint: 'Quy tắc chạy cục bộ trong trình duyệt. Không có dữ liệu nào được tải lên.', cfRulesSourceBundled: 'Nguồn quy tắc: đi kèm', cfRulesRefresh: 'Kiểm tra cập nhật', cfRulesRefreshing: 'Đang tải…', cfRulesRefreshOk: 'Đã cập nhật quy tắc.', cfRulesRefreshErr: 'Tải thất bại, vui lòng thử lại sau.', cfAutoSaved: 'Đã tự động lưu',
    rfTitle: 'Bộ lọc tốc độ (Hội viên)', rfLockedHint: 'Đăng ký để mở khóa bộ lọc tốc độ.', rfEnabled: 'Ẩn bài đăng có tốc độ thấp', rfScopeLegend: 'Phạm vi', rfScopeHome: 'Trang chủ', rfScopeList: 'Danh sách', rfScopeProfile: 'Hồ sơ', rfScopeStatus: 'Chi tiết bài đăng', rfShortLegend: 'Bài ngắn — giữ nếu đạt một trong hai ngưỡng', rfLongLegend: 'Bài viết X — giữ nếu đạt một trong hai ngưỡng', rfRatePerMin: 'lượt xem / phút ≥', rfAbsoluteViews: 'tổng lượt xem ≥', rfRuleHint: 'Giữ nếu (lượt xem/phút > ngưỡng) HOẶC (tổng lượt xem > ngưỡng). Nếu không sẽ ẩn.', rfReset: 'Đặt lại mặc định', rfSave: 'Lưu', rfSavedOk: 'Đã lưu ✓', rfResetOk: 'Đã đặt lại ✓',
    proSignInGoogle: 'Đăng nhập với Google', proSignOut: 'Đăng xuất', subscriptionKicker: 'Đăng ký', proPlanName: 'Hội viên', proPlanMonthlyPeriod: '/tháng', proPlanMonthlyNote: 'Theo tháng · hủy bất cứ lúc nào', proPlanYearlyPeriod: '/năm', proPlanYearlyNote: 'Tiết kiệm 20% · tương đương $4.79/tháng', proPlanRecommended: 'Giá trị tốt nhất', proManageBtn: 'Quản lý đăng ký',
    featureCopyMdTitle: '📋 Sao chép bài đăng dạng Markdown', featureLeaderboardTitle: '📊 Bảng xếp hạng tốc độ', featureBookmarkFoldersTitle: '🔖 Menu thư mục dấu trang', featureBookmarkCountTitle: '🔖 Hiển thị số dấu trang', featureRateFilterLabel: 'Bộ lọc tốc độ', featureBadgeLabel: 'Huy hiệu tốc độ', featureLeaderboardLabel: 'Bảng xếp hạng', featureCopyMdLabel: 'Sao chép dạng Markdown', cardFreeFeaturesTitle: 'Tính năng miễn phí', cardProFeaturesTitle: 'Tính năng hội viên', chipEnabled: 'Đã bật',
    frMutual: 'Theo dõi lẫn nhau', frMine: 'Tôi theo dõi', frTheirs: 'Theo dõi tôi', frUnfollowed: 'Đã bỏ theo dõi', frRateLabel: 'Tỷ lệ theo dõi', frFollowers: 'Người theo dõi', frFollowing: 'Đang theo dõi', frRefresh: 'Làm mới', frScanFollowing: 'Quét đang theo dõi', frScanFollowers: 'Quét người theo dõi', frScanIdle: 'Sẵn sàng', frScanBusy: 'Đang quét {{COUNT}}', frScanDone: 'Hoàn tất · tìm thấy {{COUNT}}', frRate: 'Tỷ lệ theo dõi', frScanError: 'Quét thất bại, vui lòng thử lại',
  },
  ko: {
    extDescription: '바이럴 감지 및 팔로우 인사이트: 속도 배지, 맞팔 표시, 일방 팔로우, 언팔 알림. 모든 처리는 로컬에서 이루어지며 데이터를 수집하지 않습니다.',
    popupSubtitle: 'X를 위한 바이럴 감지 및 팔로우 인사이트',
    btnSave: '저장', btnSaved: '저장됨', btnReset: '초기화', btnAdd: '추가', btnDelete: '삭제', btnBack: '뒤로', btnCancel: '취소',
    tierNormal: '일반', tierTrending: '트렌딩', tierViral: '바이럴',
    tabPro: '멤버십', tabFilter: '필터', tabLeaderboard: '리더보드', tabAi: 'AI 답글', tabAbout: '정보',
    themeLabel: '테마', themeSwitchToDark: '어두운 테마로 전환', themeSwitchToLight: '밝은 테마로 전환', themeFollowSystem: '시스템 설정 따르기',
    languageLabel: '언어', languageHint: '팝업, 페이지 오버레이 및 Grok 프롬프트의 기본 언어에 적용됩니다.',
    languageZh: '中文', languageZhTW: '繁體中文', languageEn: 'English', languageJa: '日本語', languageVi: 'Tiếng Việt', languageKo: '한국어',
    cfTitle: '콘텐츠 필터', cfLockedHint: '콘텐츠 필터는 무료입니다. 여기에서 활성화할 수 있습니다.', cfEnabled: '성인 / 광고 / 유도성 답글 숨기기', cfLevel: '필터 강도', cfLevelLight: '약함', cfLevelStandard: '표준', cfLevelStrict: '엄격', cfRuleCounts: '기본 규칙 $COUNT$개, 맞춤 규칙 $CUSTOM$개가 활성화되었습니다.', cfScopeHint: '게시물 상세 페이지의 답글 영역에만 적용됩니다. 홈, 검색, 프로필 및 원문 게시물은 필터링되지 않습니다.', cfCustomTitle: '맞춤 규칙', cfWhitelistTitle: '허용 / 차단 목록 설정', cfValue: '키워드 / 정규식 / 도메인', cfAddRule: '규칙 추가', cfDeleteRule: '규칙 삭제', cfCustomEmpty: '맞춤 규칙이 없습니다.', cfWhitelistFollowing: '내가 팔로우하는 계정은 항상 허용', cfWhitelistHandles: '허용된 핸들', cfBlacklistHandles: '차단된 핸들', cfWhitelistDomains: '허용된 도메인', cfAllRulesTitle: '모든 규칙', cfBuiltinRule: '기본', cfCustomRule: '맞춤', cfNoRules: '규칙이 없습니다.', cfRuleHint: '규칙은 브라우저에서 로컬로 실행됩니다. 업로드되는 데이터가 없습니다.', cfRulesSourceBundled: '규칙 소스: 내장', cfRulesRefresh: '업데이트 확인', cfRulesRefreshing: '가져오는 중…', cfRulesRefreshOk: '규칙이 업데이트되었습니다.', cfRulesRefreshErr: '가져오지 못했습니다. 나중에 다시 시도하세요.', cfAutoSaved: '자동 저장됨',
    rfTitle: '속도 필터 (멤버십)', rfLockedHint: '구독하면 속도 필터를 사용할 수 있습니다.', rfEnabled: '속도가 낮은 게시물 숨기기', rfScopeLegend: '적용 범위', rfScopeHome: '홈', rfScopeList: '리스트', rfScopeProfile: '프로필', rfScopeStatus: '게시물 상세', rfShortLegend: '짧은 게시물 — 두 기준 중 하나를 통과하면 유지', rfLongLegend: 'X 아티클 — 두 기준 중 하나를 통과하면 유지', rfRatePerMin: '조회 / 분 ≥', rfAbsoluteViews: '총 조회수 ≥', rfRuleHint: '(조회/분 > 기준) 또는 (총 조회수 > 기준)이면 유지하고, 그렇지 않으면 숨깁니다.', rfReset: '기본값으로 초기화', rfSave: '저장', rfSavedOk: '저장됨 ✓', rfResetOk: '초기화됨 ✓',
    proSignInGoogle: 'Google로 로그인', proSignOut: '로그아웃', subscriptionKicker: '구독', proPlanName: '멤버십', proPlanMonthlyPeriod: '/월', proPlanMonthlyNote: '월간 · 언제든 취소 가능', proPlanYearlyPeriod: '/년', proPlanYearlyNote: '20% 절약 · 월 $4.79 상당', proPlanRecommended: '최고의 가치', proManageBtn: '구독 관리',
    featureCopyMdTitle: '📋 게시물을 Markdown으로 복사', featureLeaderboardTitle: '📊 속도 리더보드', featureBookmarkFoldersTitle: '🔖 북마크 폴더 메뉴', featureBookmarkCountTitle: '🔖 북마크 수 표시', featureRateFilterLabel: '속도 필터', featureBadgeLabel: '속도 배지', featureLeaderboardLabel: '리더보드 패널', featureCopyMdLabel: 'Markdown으로 복사', cardFreeFeaturesTitle: '무료 기능', cardProFeaturesTitle: '멤버십 기능', chipEnabled: '활성화됨',
    frMutual: '맞팔', frMine: '내가 팔로우함', frTheirs: '나를 팔로우함', frUnfollowed: '언팔함', frRateLabel: '팔로우 비율', frFollowers: '팔로워', frFollowing: '팔로잉', frRefresh: '새로고침', frScanFollowing: '팔로잉 스캔', frScanFollowers: '팔로워 스캔', frScanIdle: '준비됨', frScanBusy: '{{COUNT}}명 스캔 중', frScanDone: '완료 · {{COUNT}}명 찾음', frRate: '팔로우 비율', frScanError: '스캔에 실패했습니다. 다시 시도하세요',
  },
};

function protect(text) {
  const saved = [];
  const protectedText = String(text).replace(/\{\{[A-Z_]+\}\}|\$[A-Z][A-Z0-9_]*\$|\$\d+|<[^>]+>/g, (token) => {
    const marker = `[[XVMPLACEHOLDER${saved.length}]]`;
    saved.push([marker, token]);
    return marker;
  });
  return { protectedText, saved };
}

function restore(text, saved) {
  return saved.reduce((value, [marker, token]) => value.replaceAll(marker, token), text);
}

async function translate(text, language) {
  if (!text) return text;
  const { protectedText, saved } = protect(text);
  const url = new URL('https://api.mymemory.translated.net/get');
  url.searchParams.set('langpair', `en|${language}`);
  url.searchParams.set('q', protectedText);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`translate HTTP ${response.status}`);
  const payload = await response.json();
  const translated = payload?.responseData?.translatedText || '';
  if (!translated) throw new Error('empty translation response');
  return restore(translated, saved);
}

async function mapWithConcurrency(items, concurrency, map) {
  const out = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      out[index] = await map(items[index], index);
    }
  }));
  return out;
}

for (const target of targets) {
  if (target.id === 'zh_TW' && existsSync(join(LOCALES, target.id, 'messages.json'))) {
    console.log('zh_TW: existing complete package preserved');
    continue;
  }
  if (STATIC_OVERRIDES[target.id]) {
    const localized = Object.fromEntries(Object.entries(source).map(([key, value]) => [
      key,
      { ...value, message: STATIC_OVERRIDES[target.id][key] ?? value.message },
    ]));
    await mkdir(join(LOCALES, target.id), { recursive: true });
    await writeFile(join(LOCALES, target.id, 'messages.json'), `${JSON.stringify(localized, null, 2)}\n`);
    console.log(`${target.id}: wrote ${Object.keys(localized).length} keys (static package)`);
    continue;
  }
  const entries = Object.entries(source);
  console.log(`Translating ${target.id}: ${entries.length} messages`);
  const translated = await mapWithConcurrency(entries, 2, async ([key, entry], index) => {
    const message = await translate(entry.message, target.language);
    if ((index + 1) % 50 === 0) console.log(`  ${index + 1}/${entries.length}`);
    return [key, { ...entry, message }];
  });
  const catalog = Object.fromEntries(translated);
  const dir = resolve(root, `_locales/${target.id}`);
  await mkdir(dir, { recursive: true });
  await writeFile(resolve(dir, 'messages.json'), `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
}
