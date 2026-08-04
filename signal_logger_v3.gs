/**
 * MasterPlan / JAB / Hook 기록 — Apps Script 웹앱  (v3)
 * ------------------------------------------------------
 * v2에서 바뀐 것
 *  1) JAB 스키마 교체: 신호(buy/hold/tp/cut) → 밴드 리밸런싱 원장
 *     (주수·가격·평가액·비중·판정·주문량). 옛 JAB 탭이 있으면
 *     이름을 JAB_OLD 로 바꾼 뒤 새 JAB 탭을 만듭니다.
 *  2) HOOK 스키마 추가: 이벤트 기반(개시 / 밴드점검 / 종료)만 기록.
 *     대기 중 낙폭은 가격에서 언제든 재계산되므로 남기지 않습니다.
 *  3) 중복 방지 키를 탭마다 다르게: MASTERPLAN·JAB = 날짜,
 *     HOOK = 날짜+이벤트 (같은 날 개시와 첫 점검이 겹칠 수 있음).
 *
 * 설치
 *  1) 구글시트 → 확장 프로그램 → Apps Script
 *  2) 이 코드 전체를 붙여넣고 저장
 *  3) SECRET 을 바꾸기 (신호탑 HTML에 넣을 값과 같아야 함)
 *  4) 배포 → 새 배포 → 유형: 웹 앱
 *       실행 계정: 나 / 액세스 권한: 모든 사용자
 *  5) 나온 /exec URL 을 각 신호탑의 "시트 연결"에 붙여넣기
 *
 * 이미 v2로 배포해 두었다면, 코드를 갈아끼운 뒤
 * 배포 → 배포 관리 → 편집(연필) → 버전: 새 버전 → 배포
 * 를 눌러야 URL 그대로 새 코드가 반영됩니다.
 */

var SECRET = 'RlC72nwnPQWbAqQcaRN4SQeQtCAJZLHm';   // ← 반드시 바꾸고, 신호탑과 동일하게

// ── 탭별 컬럼 정의 (순서 = 시트 컬럼 순서) ─────────────────
var SCHEMA = {

  // 마스터플랜: 매일 판정하는 신호. 기존 그대로.
  MASTERPLAN: {
    key: ['date'],
    cols: [
      'ts',          // 기록 시각
      'date',        // 기준일 (마지막 봉 날짜)
      'state',       // STRONG / MID / OUT
      'prevState',   // 전일 상태
      'changed',     // 전환 발생 여부
      'asset',       // 매핑 자산
      'close',       // QQQ 종가
      'sma',         // SMA65
      'ema',         // EMA200
      'smaOverEma',  // SMA/EMA - 1 (%)
      'adx',
      'atr',
      'atrStop',     // ATR 트레일링 손절선
      'highPeak',    // 사이클 최고가
      'vol',         // 실현변동성 %
      'volUp',       // 밴드 상단
      'volDown',     // 밴드 하단
      'early',       // E·R 선행진입 상태
      'exitCause',   // 직전 청산 사유
      'params',
      'src'
    ]
  },

  // 잽: 14일마다 한 번. 그날의 포지션과 주문이 본체.
  JAB: {
    key: ['date'],
    cols: [
      'ts',          // 기록 시각
      'date',        // 점검일
      'onSchedule',  // 예정된 점검일이었나 (TRUE/FALSE)
      'verdict',     // HOLD / SELL / BUY
      'reason',      // 사람이 읽는 판정 근거
      'tqqqShares',
      'tqqqPrice',
      'tqqqValue',
      'boxxShares',
      'boxxPrice',
      'boxxValue',
      'potTotal',    // 주머니 합계
      'weightPct',   // TQQQ 비중 %
      'devPp',       // 목표 50%에서 벗어난 %p
      'tradeAmt',    // 이동 금액 (+면 TQQQ 매도)
      'tqqqDelta',   // TQQQ 주문 주수 (−매도 / +매수)
      'boxxDelta',   // BOXX 주문 주수
      'nextCheck',   // 다음 점검일
      'priceSrc',    // 가격 출처
      'note'
    ]
  },

  // 훅: 이벤트만. OPEN(개시) / BAND(밴드점검) / CLOSE(종료)
  HOOK: {
    key: ['date', 'event'],
    cols: [
      'ts',
      'date',
      'event',        // OPEN / BAND / CLOSE
      'verdict',      // 개시 / 유지 / QLD 매도 / QLD 매수 / 종료
      'reason',
      'qqq',          // QQQ 종가
      'refPeak',      // 개시일 = 52주 고점, 이후 = 동결 원고점
      'ddPct',        // 고점 대비 낙폭 % (개시일)
      'recoveryPct',  // 원고점 회복률 % (가동 중)
      'qldShares',
      'qldPrice',
      'qldValue',
      'boxxShares',
      'boxxPrice',
      'boxxValue',
      'potTotal',
      'qldWeightPct', // QLD 비중 % (목표 40)
      'tradeAmt',
      'qldDelta',     // QLD 주문 주수
      'boxxDelta',
      'note',
      'src'
    ]
  }
};

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    if (body.secret !== SECRET) return _out({ ok: false, err: 'bad secret' });

    var sys = String(body.system || '').toUpperCase();
    var def = SCHEMA[sys];
    if (!def) return _out({ ok: false, err: 'unknown system: ' + sys });

    var cols = def.cols;
    var sh = _sheet(sys, cols);
    var src = body.row || {};
    var row = cols.map(function (c) {
      var v = src[c];
      return (v === undefined || v === null) ? '' : v;
    });

    // 중복 방지: 키 컬럼이 모두 같은 행이 있으면 덮어쓰기
    var target = _findRow(sh, cols, def.key, src);
    if (target) sh.getRange(target, 1, 1, cols.length).setValues([row]);
    else        sh.appendRow(row);

    return _out({
      ok: true, system: sys,
      date: src.date, event: src.event || '',
      mode: target ? 'update' : 'append'
    });
  } catch (err) {
    return _out({ ok: false, err: String(err) });
  }
}

function doGet() {
  return _out({ ok: true, msg: 'signal logger v3 alive', systems: Object.keys(SCHEMA) });
}

function _findRow(sh, cols, keyCols, src) {
  var last = sh.getLastRow();
  if (last < 2) return 0;

  var idx = keyCols.map(function (k) { return cols.indexOf(k); });
  if (idx.some(function (i) { return i < 0; })) return 0;

  var vals = sh.getRange(2, 1, last - 1, cols.length).getDisplayValues();
  for (var r = 0; r < vals.length; r++) {
    var hit = true;
    for (var j = 0; j < idx.length; j++) {
      if (String(vals[r][idx[j]]) !== String(src[keyCols[j]])) { hit = false; break; }
    }
    if (hit) return r + 2;
  }
  return 0;
}

function _sheet(name, cols) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(name);

  // 기존 탭의 헤더가 새 스키마와 다르면 옛 탭을 보존하고 새로 만든다
  if (sh && sh.getLastRow() === 0) sh = null;   // 비어 있는 탭은 그대로 재사용

  if (sh) {
    var width = sh.getLastColumn();
    var head = width ? sh.getRange(1, 1, 1, width).getDisplayValues()[0] : [];
    if (head.join('|') !== cols.join('|')) {
      var archive = name + '_OLD';
      var n = 1;
      while (ss.getSheetByName(archive)) { n++; archive = name + '_OLD' + n; }
      sh.setName(archive);
      sh = null;
    }
  }

  if (!sh) {
    sh = ss.insertSheet(name);
    // 전 컬럼을 텍스트 서식으로 고정한다.
    // 그래야 '2026-07-20' 이 날짜 값으로 자동 변환되지 않고,
    // _findRow 의 getDisplayValues() 비교(=중복 방지)가 실제로 맞는다.
    sh.getRange(1, 1, sh.getMaxRows(), cols.length).setNumberFormat('@');
    sh.appendRow(cols);
    sh.getRange(1, 1, 1, cols.length).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

function _out(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * 이미 만들어 둔 탭이 있다면 한 번만 실행하십시오.
 * 날짜가 날짜값으로 저장돼 있던 것을 텍스트로 되돌려,
 * 중복 방지(덮어쓰기)가 그 탭에서도 동작하게 만듭니다.
 * Apps Script 편집기에서 함수 선택 → repairFormats → 실행.
 */
function repairFormats() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  Object.keys(SCHEMA).forEach(function (name) {
    var sh = ss.getSheetByName(name);
    if (!sh) return;
    var cols = SCHEMA[name].cols;
    var last = sh.getLastRow();
    sh.getRange(1, 1, sh.getMaxRows(), cols.length).setNumberFormat('@');
    if (last < 2) return;
    var di = cols.indexOf('date') + 1;
    if (di < 1) return;
    var rng = sh.getRange(2, di, last - 1, 1);
    var tz  = ss.getSpreadsheetTimeZone();
    var out = rng.getValues().map(function (r) {
      var v = r[0];
      // 날짜값으로 변환돼 있던 것만 ISO 문자열로 되돌린다
      return [ (v instanceof Date) ? Utilities.formatDate(v, tz, 'yyyy-MM-dd') : String(v) ];
    });
    rng.setValues(out);
  });
}
