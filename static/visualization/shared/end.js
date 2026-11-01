// All deferred scripts are initialized before an early model response starts data loading.
viewerReady = true;
if (model) refreshRobotData();
requestAnimationFrame(render);

window.addEventListener('resize', (ev) => {
    invalidateScene();
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});
