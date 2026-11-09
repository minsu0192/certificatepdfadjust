(() => {
  const cards = [...document.querySelectorAll('.tool-card')];
  const tabs = [...document.querySelectorAll('.category-tab')];
  const search = document.getElementById('toolSearch');
  let category = 'all';
  const normalize = value => value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim();
  function render() {
    const terms = normalize(search.value).split(' ').filter(Boolean);
    let count = 0;
    for (const card of cards) {
      const text = normalize(`${card.textContent} ${card.dataset.keywords}`);
      card.hidden = (category !== 'all' && card.dataset.category !== category) || !terms.every(term => text.includes(term));
      if (!card.hidden) count++;
    }
    for (const tab of tabs) {
      const active = tab.dataset.category === category;
      tab.classList.toggle('is-active', active); tab.setAttribute('aria-pressed', String(active));
    }
    document.getElementById('toolCount').textContent = `${count}개 도구`;
    document.getElementById('emptyState').hidden = count > 0;
  }
  tabs.forEach(tab => tab.addEventListener('click', () => { category = tab.dataset.category; render(); }));
  search.addEventListener('input', render);
  document.getElementById('clearFilters').addEventListener('click', () => { category = 'all'; search.value = ''; render(); search.focus(); });
  render();
})();
