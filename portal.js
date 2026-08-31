document.querySelectorAll('.category-tab').forEach(button => {
  button.addEventListener('click', () => {
    document.querySelectorAll('.category-tab').forEach(tab => tab.classList.remove('is-active'));
    button.classList.add('is-active');
    const category = button.dataset.category;
    document.querySelectorAll('.tool-card').forEach(card => {
      card.hidden = category !== 'all' && card.dataset.category !== category;
    });
  });
});
