const reportTool = document.getElementById('reportTool');
try {
  const requested = new URL(location.href).searchParams.get('tool');
  const from = requested || new URL(document.referrer).pathname.split('/')[2];
  const names = { 'ai-table': 'CSV · PDF 형식 변환', 'pdf-workbench': 'PDF · 이미지 워크스페이스', 'import-certificate': '수입신고필증 정리', 'dhl-invoice': 'DHL Pre-Alert 메일 본문 정리', 'celine-credit-note': 'CELINE 크레딧 노트 정리', 'fedex-dhl-extractor': 'FedEx Invoice Check', 'dhl-pdf-extractor': 'DHL Invoice Check' };
  if (names[from]) reportTool.value = names[from];
} catch { /* Direct visit without a referrer. */ }
function reportText() {
  const value = id => document.getElementById(id).value.trim();
  return ['LVMH Fashion Group 업무 자동화 도구 오류 보고서', `생성 시각: ${new Date().toISOString()}`, `도구: ${value('reportTool')}`, `파일명: ${value('reportFile') || '(미입력)'}`, `브라우저: ${navigator.userAgent}`, `페이지: ${document.referrer || '(직접 접속)'}`, '', '[오류 메시지]', value('reportError') || '(미입력)', '', '[발생 과정]', value('reportSteps') || '(미입력)'].join('\n');
}
document.getElementById('copyReport').addEventListener('click', async event => {
  const button = event.currentTarget; button.disabled = true;
  try { await navigator.clipboard.writeText(reportText()); document.getElementById('reportStatus').textContent = '보고서를 복사했습니다. 사내 메신저나 이메일에 붙여넣어 주세요.'; }
  catch { document.getElementById('reportStatus').textContent = '클립보드에 복사하지 못했습니다. TXT 다운로드를 이용해 주세요.'; }
  finally { button.disabled = false; }
});
document.getElementById('downloadReport').addEventListener('click', () => {
  const a = document.createElement('a'), url = URL.createObjectURL(new Blob([reportText()], { type: 'text/plain;charset=utf-8' }));
  a.href = url; a.download = `업무도구_오류보고서_${Date.now()}.txt`; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  document.getElementById('reportStatus').textContent = '보고서 TXT 파일을 저장했습니다.';
});
