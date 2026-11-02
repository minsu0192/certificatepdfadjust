// @jspawn/qpdf-wasm 0.0.2 (Apache-2.0), served locally with its license.
importScripts('vendor/qpdf/qpdf.js');

self.onmessage = async ({ data: { data, password } }) => {
  let diagnostic = '';
  // This build binds stderr to console.warn rather than Module.printErr.
  console.warn = line => { diagnostic += `${line}\n`; };
  console.log = () => {};
  try {
    const qpdf = await Module({
      locateFile: name => new URL(`vendor/qpdf/${name}`, self.location.href).href
    });
    qpdf.FS.writeFile('/input.pdf', new Uint8Array(data));
    const status = qpdf.callMain([
      `--password=${password}`, '--decrypt', '/input.pdf', '/output.pdf'
    ]);
    if (status !== 0 && status !== 3) throw new Error('decrypt failed');
    const bytes = qpdf.FS.readFile('/output.pdf');
    if (!bytes.length) throw new Error('empty output');
    self.postMessage({ bytes }, [bytes.buffer]);
  } catch (_) {
    const error = /invalid password|password required/i.test(diagnostic)
      ? '비밀번호가 없거나 올바르지 않습니다. PDF 비밀번호를 확인한 뒤 다시 입력하세요.'
      : 'PDF 잠금을 해제하지 못했습니다. 파일이 손상되었거나 지원하지 않는 보안 방식일 수 있습니다.';
    self.postMessage({ error });
  } finally {
    self.close();
  }
};
