document.getElementById('openFolderBtn').addEventListener('click', openFolder);
document.getElementById('loadServerImagesBtn').addEventListener('click', loadServerImages);
document.getElementById('openCurrentFolderBtn').addEventListener('click', openCurrentFolderInFinder);
document.getElementById('toggleSidebarBtn').addEventListener('click', toggleSidebar);
document.getElementById('quickOpenFolderBtn').addEventListener('click', openQuickFolder);
document.getElementById('settingsBtn').addEventListener('click', openSettings);
document.getElementById('settingsClose').addEventListener('click', closeSettings);
document.getElementById('chooseQuickOpenFolderBtn').addEventListener('click', chooseQuickOpenFolder);
document.getElementById('addQuickOpenFolderBtn').addEventListener('click', addQuickOpenFolder);
document.getElementById('modalClose').addEventListener('click', closeModal);
document.getElementById('toggleModalTagsBtn').addEventListener('click', toggleModalTags);
document.getElementById('showModalTagsBtn').addEventListener('click', () => setModalTagsExpanded(true));
document.getElementById('modalPrev').addEventListener('click', showPrevImage);
document.getElementById('modalNext').addEventListener('click', showNextImage);
document.getElementById('addTagBtn').addEventListener('click', addNewTag);
document.getElementById('deleteBtn').addEventListener('click', deleteCurrentImage);
document.getElementById('quickAddTagBtn').addEventListener('click', quickAddTag);
document.getElementById('modalQuickAddTagBtn').addEventListener('click', modalQuickAddTag);
document.getElementById('showInFolderBtn').addEventListener('click', showCurrentImageInFolder);

imageGrid.addEventListener('click', (event) => {
    if (handleWaterfallGridClick(event)) return;

    const item = event.target.closest('.file-item');
    if (!item) return;

    openImageModal(parseInt(item.dataset.index, 10));
});

imageGrid.addEventListener('contextmenu', (event) => {
    if (handleWaterfallContextMenu(event)) {
        event.preventDefault();
    }
});

imageGrid.addEventListener('scroll', scheduleVirtualGridRender);
imageGrid.addEventListener('wheel', (event) => {
    if (handleWaterfallWheel(event)) {
        event.preventDefault();
    }
}, { passive: false });
window.addEventListener('resize', refreshVirtualGridLayout);

tagFilter.addEventListener('click', (event) => {
    const tagEl = event.target.closest('.filter-tag');
    if (!tagEl) return;

    toggleFilterTag(tagEl.dataset.tag);
});

const addCategoryBtn = document.getElementById('addCategoryBtn');
if (addCategoryBtn) {
    addCategoryBtn.addEventListener('click', addNewCategory);
}

const newCategoryName = document.getElementById('newCategoryName');
if (newCategoryName) {
    newCategoryName.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') addNewCategory();
    });
}

const emptyTrashBtn = document.getElementById('emptyTrashBtn');
if (emptyTrashBtn) {
    emptyTrashBtn.addEventListener('click', emptyTrash);
}

const clearRecentOpenFilesBtn = document.getElementById('clearRecentOpenFilesBtn');
if (clearRecentOpenFilesBtn) {
    clearRecentOpenFilesBtn.addEventListener('click', clearRecentOpenFiles);
}

const exportConfigBtn = document.getElementById('exportConfigBtn');
if (exportConfigBtn) {
    exportConfigBtn.addEventListener('click', exportConfig);
}

const importConfigBtn = document.getElementById('importConfigBtn');
if (importConfigBtn) {
    importConfigBtn.addEventListener('click', importConfig);
}

const scanDuplicatesBtn = document.getElementById('scanDuplicatesBtn');
if (scanDuplicatesBtn) {
    scanDuplicatesBtn.addEventListener('click', scanDuplicateImages);
}

const deleteDuplicateImagesBtn = document.getElementById('deleteDuplicateImagesBtn');
if (deleteDuplicateImagesBtn) {
    deleteDuplicateImagesBtn.addEventListener('click', deleteDuplicateImagesDistinct);
}

const selectMigrateFolderBtn = document.getElementById('selectMigrateFolderBtn');
if (selectMigrateFolderBtn) {
    selectMigrateFolderBtn.addEventListener('click', selectMigrateFolder);
}

const selectServerDownloadFolderBtn = document.getElementById('selectServerDownloadFolderBtn');
if (selectServerDownloadFolderBtn) {
    selectServerDownloadFolderBtn.addEventListener('click', selectServerDownloadFolder);
}

const serverDownloadConcurrencyInput = document.getElementById('serverDownloadConcurrencyInput');
if (serverDownloadConcurrencyInput) {
    serverDownloadConcurrencyInput.addEventListener('change', saveServerDownloadConcurrency);
}

const migrateImagesBtn = document.getElementById('migrateImagesBtn');
if (migrateImagesBtn) {
    migrateImagesBtn.addEventListener('click', migrateImages);
}

const startCompetitionBtn = document.getElementById('startCompetitionBtn');
if (startCompetitionBtn) {
    startCompetitionBtn.addEventListener('click', startImageCompetition);
}

const competitionCloseBtn = document.getElementById('competitionClose');
if (competitionCloseBtn) {
    competitionCloseBtn.addEventListener('click', closeCompetition);
}

const competitionBody = document.getElementById('competitionBody');
if (competitionBody) {
    competitionBody.addEventListener('click', (event) => {
        const button = event.target.closest('.competition-image-btn[data-choice-index]');
        if (!button) return;
        chooseCompetitionWinner(Number(button.dataset.choiceIndex));
    });
}

const competitionGroupSizeSelect = document.getElementById('competitionGroupSizeSelect');
if (competitionGroupSizeSelect) {
    competitionGroupSizeSelect.addEventListener('change', (event) => {
        setCompetitionGroupSize(event.target.value);
    });
}

const competitionRevealBtn = document.getElementById('competitionRevealBtn');
if (competitionRevealBtn) {
    competitionRevealBtn.addEventListener('click', revealCompetitionChampion);
}

const competitionRestartBtn = document.getElementById('competitionRestartBtn');
if (competitionRestartBtn) {
    competitionRestartBtn.addEventListener('click', restartImageCompetition);
}

const zoomInBtn = document.getElementById('zoomInBtn');
if (zoomInBtn) {
    zoomInBtn.addEventListener('click', zoomIn);
}

const zoomOutBtn = document.getElementById('zoomOutBtn');
if (zoomOutBtn) {
    zoomOutBtn.addEventListener('click', zoomOut);
}

const zoomResetBtn = document.getElementById('zoomResetBtn');
if (zoomResetBtn) {
    zoomResetBtn.addEventListener('click', zoomReset);
}

document.getElementById('newTagInput').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') addNewTag();
});

document.getElementById('quickTagInput').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') quickAddTag();
});

document.getElementById('modalQuickTagInput').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') modalQuickAddTag();
});

imageModal.querySelector('.modal-backdrop').addEventListener('click', closeModal);
competitionModal.querySelector('.modal-backdrop').addEventListener('click', closeCompetition);
settingsModal.querySelector('.modal-backdrop').addEventListener('click', closeSettings);

document.addEventListener('keydown', handleKeyboard);
const sortSelect = document.getElementById('sortSelect');
if (sortSelect) {
    sortSelect.addEventListener('change', (e) => {
        currentSort = e.target.value;
        if (currentSort === 'random') {
            resetRandomSortOrder();
        }
        renderImages();
    });
}

document.querySelectorAll('.view-mode-btn').forEach(btn => {
    btn.addEventListener('click', () => setViewMode(btn.dataset.view));
});

function toggleSidebar() {
    setSidebarCollapsed(!isSidebarCollapsed);
}

function setSidebarCollapsed(collapsed, options = {}) {
    isSidebarCollapsed = Boolean(collapsed);
    const appContainer = document.querySelector('.app-container');
    const toggleButton = document.getElementById('toggleSidebarBtn');

    appContainer?.classList.toggle('sidebar-hidden', isSidebarCollapsed);
    if (toggleButton) {
        toggleButton.setAttribute('aria-expanded', String(!isSidebarCollapsed));
        toggleButton.title = isSidebarCollapsed ? '显示标签栏' : '隐藏标签栏';
        toggleButton.classList.toggle('sidebar-is-hidden', isSidebarCollapsed);
    }
    if (options.persist !== false) {
        localStorage.setItem('macimage:sidebarCollapsed', String(isSidebarCollapsed));
    }

    requestAnimationFrame(() => refreshVirtualGridLayout());
}

const modalImageEl = document.getElementById('modalImage');
if (modalImageEl) {
    let modalImageWasDragged = false;

    modalImageEl.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        modalImageWasDragged = false;

        if (currentZoom > 1) {
            isDragging = true;
            dragStartX = e.clientX - imageTranslateX * currentZoom;
            dragStartY = e.clientY - imageTranslateY * currentZoom;
            modalImageEl.style.cursor = 'grabbing';
        }
    });
    
    modalImageEl.addEventListener('mousemove', (e) => {
        if (isDragging && currentZoom > 1) {
            modalImageWasDragged = true;
            imageTranslateX = (e.clientX - dragStartX) / currentZoom;
            imageTranslateY = (e.clientY - dragStartY) / currentZoom;
            modalImageEl.style.transform = `scale(${currentZoom}) translate(${imageTranslateX}px, ${imageTranslateY}px)`;
        }
    });
    
    modalImageEl.addEventListener('mouseup', () => {
        isDragging = false;
        modalImageEl.style.cursor = currentZoom > 1 ? 'grab' : 'pointer';
    });
    
    modalImageEl.addEventListener('mouseleave', () => {
        isDragging = false;
        modalImageEl.style.cursor = currentZoom > 1 ? 'grab' : 'pointer';
    });

    modalImageEl.addEventListener('click', () => {
        if (modalImageWasDragged) {
            modalImageWasDragged = false;
            return;
        }
        if (closeModalOnImageClick) closeModal();
    });
}

const modalImageContainer = document.querySelector('.modal-image-container');
if (modalImageContainer) {
    modalImageContainer.addEventListener('dblclick', handleModalFavoriteDblClick);
    modalImageContainer.addEventListener('contextmenu', handleModalDeleteContextMenu);
    modalImageContainer.addEventListener('wheel', handleModalWheel);
}

setSidebarCollapsed(isSidebarCollapsed, { persist: false });

window.electronAPI.onOpenFolder(async (folderPath) => {
    await loadFolder(folderPath);
});

window.electronAPI.onOpenImageFile(async (imageInfo) => {
    await loadImageFile(imageInfo);
});

window.electronAPI.onTrashFolderChanged((folderPath) => {
    trashFolder = folderPath;
    updateTrashFolderDisplay();
});

window.electronAPI.onUndoDelete(() => {
    undoLastDelete();
});

init().then(() => {
    return window.electronAPI.rendererReady();
}).catch((error) => {
    console.error('Failed to initialize app:', error);
});
