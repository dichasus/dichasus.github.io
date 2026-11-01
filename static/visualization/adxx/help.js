const helpDialog = document.getElementById('help-modal');
function openHelp() {
    controls.unlock();
    pressedKeys.clear();
    helpDialog.showModal();
}
function closeHelp() {
    helpDialog.close();
}
document.getElementById('help-button').addEventListener('click', openHelp);
document.getElementById('close-help-modal').addEventListener('click', closeHelp);
document.getElementById('help-done').addEventListener('click', closeHelp);
helpDialog.addEventListener('click', (event) => {
    if (event.target !== helpDialog) return;
    const rect = helpDialog.getBoundingClientRect();
    if (
        event.clientX < rect.left ||
        event.clientX > rect.right ||
        event.clientY < rect.top ||
        event.clientY > rect.bottom
    )
        closeHelp();
});
document.addEventListener('keydown', (event) => {
    if (event.key === '?' && !isEditingControl(event.target) && !helpDialog.open) openHelp();
});
