function isImageFile(file) {
  return /\.(png|jpe?g|webp|gif|bmp)$/i.test(file.name) || /^image\/(png|jpeg|webp|gif|bmp)$/.test(file.type);
}

(() => {
  const $ = id => document.getElementById(id);
  $('pdfImageFormat').onchange = () => { $('pdfImageQualityField').hidden = $('pdfImageFormat').value === 'png'; };
  function updateOptions() {
    $('imageQualityField').hidden = $('imageFormat').value === 'png';
    $('imageBackgroundField').hidden = $('imageFormat').value !== 'jpeg';
  }
  $('imageFormat').onchange = updateOptions; updateOptions();
  $('imageQuality').oninput = () => { $('imageQualityValue').textContent = `${$('imageQuality').value}%`; };
  $('imageRun').onclick = () => handle(async () => {
    const files = [...state.image];
    if (!files.length) throw new Error('변환할 PNG, JPG, WebP, GIF 또는 BMP 이미지를 선택하세요.');
    const format = $('imageFormat').value;
    const mime = `image/${format}`;
    const extension = format === 'jpeg' ? 'jpg' : format;
    const quality = Number($('imageQuality').value) / 100;
    const background = $('imageBackground').value;
    const sizeValue = $('imageMaxSize').value.trim();
    const maxSize = sizeValue ? Number(sizeValue) : 0;
    if (sizeValue && (!Number.isInteger(maxSize) || maxSize < 1 || maxSize > 16000)) throw new Error('최대 크기는 1~16000 사이의 정수로 입력하세요.');
    if (files.length > 1 && !window.JSZip) throw new Error('ZIP 라이브러리를 불러오지 못했습니다. 새로고침 후 다시 시도하세요.');
    await withBusy('이미지를 변환하는 중...', async update => {
      const zip = files.length > 1 ? new JSZip() : null;
      for (let i = 0; i < files.length; i++) {
        const file = files[i]; let img;
        try {
          try { img = await createImageBitmap(file); } catch { throw new Error(`${file.name}: 읽을 수 없는 이미지입니다. 지원 형식과 파일 손상 여부를 확인하세요.`); }
          const scale = maxSize ? Math.min(1, maxSize / Math.max(img.width, img.height)) : 1;
          const width = Math.max(1, Math.round(img.width * scale));
          const height = Math.max(1, Math.round(img.height * scale));
          if (width > 16384 || height > 16384 || width * height > 64000000) throw new Error(`${file.name}: 이미지가 너무 큽니다. 긴 변 최대 크기를 4000px 이하로 설정해 주세요.`);
          const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
          const context = canvas.getContext('2d');
          if (format === 'jpeg') { context.fillStyle = background; context.fillRect(0, 0, width, height); }
          context.drawImage(img, 0, 0, width, height);
          const blob = await new Promise((resolve, reject) => canvas.toBlob(result => result ? resolve(result) : reject(new Error('이미지 변환에 실패했습니다. 크기를 줄여 다시 시도하세요.')), mime, quality));
          if (blob.type !== mime) throw new Error('이 브라우저는 선택한 형식으로 저장할 수 없습니다. PNG 또는 JPG를 선택하세요.');
          const name = `${zip ? String(i + 1).padStart(3, '0') + '_' : ''}${baseName(file.name)}.${extension}`;
          if (zip) zip.file(name, blob); else downloadBlob(blob, name);
          canvas.width = canvas.height = 0;
          update((i + 1) / files.length * 100, `${i + 1}/${files.length} 이미지 변환 완료`);
        } finally { if (img) img.close(); }
      }
      if (zip) downloadBlob(await zip.generateAsync({ type: 'blob' }), `images_${extension}.zip`);
      showResult('이미지 변환 완료', `${files.length}개 이미지를 ${extension.toUpperCase()}로 저장했습니다.`);
    });
  });
})();
