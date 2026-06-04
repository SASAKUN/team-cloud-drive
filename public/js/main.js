// Global scripts for Team Cloud Drive
document.addEventListener('DOMContentLoaded', () => {
  // Auto-dismiss success alerts after 4 seconds
  const alerts = document.querySelectorAll('.alert-success');
  alerts.forEach(alert => {
    setTimeout(() => {
      alert.style.transition = 'opacity 0.4s ease';
      alert.style.opacity = '0';
      setTimeout(() => alert.remove(), 400);
    }, 4000);
  });
});
