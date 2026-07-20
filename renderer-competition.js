function startImageCompetition() {
    if (images.length < 2) {
        alert('当前文件夹至少需要 2 张图片才能开始竞赛');
        return;
    }

    const countInput = document.getElementById('competitionCountInput');
    const groupSize = normalizeCompetitionGroupSize(competitionGroupSize);
    const maxRounds = getMaxCompetitionRounds(images.length, groupSize);
    const requestedRounds = Math.floor(Number(countInput ? countInput.value : 3));
    const roundCount = Math.min(Math.max(requestedRounds || 1, 1), maxRounds);
    const participantCount = Math.min(groupSize ** roundCount, images.length);
    if (countInput) {
        countInput.value = roundCount;
        countInput.max = maxRounds;
        countInput.title = `${groupSize} 选 1 · ${roundCount} 轮会抽取 ${participantCount} 张图片`;
    }

    const participants = selectCompetitionParticipants(images, participantCount);
    competitionState = {
        participants,
        currentRound: participants,
        pendingWinners: [],
        roundNumber: 1,
        matchIndex: 0,
        currentMatch: null,
        champion: null,
        isBusy: false,
        roundLimit: roundCount,
        participantCount,
        groupSize
    };

    showCompetitionModal();
    renderCompetitionMatch();
}

function updateCompetitionLauncherState() {
    const countInput = document.getElementById('competitionCountInput');
    const startBtn = document.getElementById('startCompetitionBtn');

    if (countInput) {
        const groupSize = normalizeCompetitionGroupSize(competitionGroupSize);
        const maxRounds = getMaxCompetitionRounds(images.length, groupSize);
        const participantCount = images.length >= 2 ? Math.min(groupSize ** maxRounds, images.length) : 0;
        countInput.max = maxRounds;
        countInput.disabled = images.length < 2;
        const currentValue = Math.floor(Number(countInput.value)) || 3;
        countInput.value = images.length >= 2
            ? Math.min(Math.max(currentValue, 1), maxRounds)
            : 1;
        countInput.title = images.length >= 2
            ? `${groupSize} 选 1 · 最多 ${maxRounds} 轮，可抽取 ${participantCount} 张图片`
            : '当前文件夹至少需要 2 张图片';
    }
    if (startBtn) {
        startBtn.disabled = images.length < 2;
    }
}

function getMaxCompetitionRounds(imageCount, groupSize = competitionGroupSize) {
    const normalizedGroupSize = normalizeCompetitionGroupSize(groupSize);
    return Math.max(1, Math.ceil(Math.log(Math.max(imageCount, 2)) / Math.log(normalizedGroupSize)));
}

function showCompetitionModal() {
    closeModal();
    closeSettings();
    competitionModal.classList.add('show');
}

function closeCompetition() {
    competitionModal.classList.remove('show');
    competitionState = null;
}

function shuffleImages(sourceImages) {
    const shuffled = [...sourceImages];
    for (let index = shuffled.length - 1; index > 0; index--) {
        const swapIndex = Math.floor(Math.random() * (index + 1));
        [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
    }
    return shuffled;
}

function selectCompetitionParticipants(sourceImages, participantCount) {
    const selectedImages = [...sourceImages]
        .map(img => ({ img, matches: getImageMatchCount(img), random: Math.random() }))
        .sort((a, b) => a.matches - b.matches || a.random - b.random)
        .slice(0, participantCount)
        .map(item => item.img);

    return shuffleImages(selectedImages);
}

function getCompetitionMatchCount(roundImages) {
    if (!competitionState) return 0;
    return Math.ceil(roundImages.length / competitionState.groupSize);
}

function renderCompetitionMatch() {
    if (!competitionState) return;

    const bodyEl = document.getElementById('competitionBody');
    const championEl = document.getElementById('competitionChampion');
    const statusEl = document.getElementById('competitionStatus');
    if (!bodyEl || !championEl || !statusEl) return;

    championEl.style.display = 'none';
    bodyEl.style.display = 'grid';

    while (competitionState.matchIndex < competitionState.currentRound.length) {
        const group = competitionState.currentRound.slice(
            competitionState.matchIndex,
            competitionState.matchIndex + competitionState.groupSize
        );
        if (group.length === 1) {
            competitionState.pendingWinners.push(group[0]);
            competitionState.matchIndex += competitionState.groupSize;
            continue;
        }

        competitionState.currentMatch = group;
        const matchNumber = Math.floor(competitionState.matchIndex / competitionState.groupSize) + 1;
        const matchCount = getCompetitionMatchCount(competitionState.currentRound);
        statusEl.textContent = `第 ${competitionState.roundNumber} 轮 · 第 ${matchNumber} / ${matchCount} 组 · ${group.length} 选 1`;
        renderCompetitionChoices(group);
        setCompetitionBusy(false);
        return;
    }

    finishCompetitionRound();
}

function renderCompetitionChoices(group) {
    const bodyEl = document.getElementById('competitionBody');
    if (!bodyEl) return;

    bodyEl.className = `competition-body choice-count-${group.length}`;
    bodyEl.innerHTML = group.map((img, index) => `
        <div class="competition-choice">
            <button class="competition-image-btn" data-choice-index="${index}" title="选择第 ${index + 1} 张">
                <img src="${toFileUrl(img.path)}" alt="${escapeAttribute(img.name)}">
            </button>
            <div class="competition-image-meta">
                <strong title="${escapeAttribute(img.path)}">${escapeHtml(img.name)}</strong>
                <span>${escapeHtml(formatImageRating(img))}</span>
            </div>
        </div>
    `).join('');
}

async function chooseCompetitionWinner(choiceIndex) {
    if (!competitionState || competitionState.isBusy || !competitionState.currentMatch) return;

    const winnerIndex = Math.floor(Number(choiceIndex));
    const group = competitionState.currentMatch;
    const winner = group[winnerIndex];
    if (!winner) return;

    const losers = group.filter((img, index) => index !== winnerIndex);
    setCompetitionBusy(true);
    const result = await window.electronAPI.recordCompetitionGroupResult(winner.path, losers.map(img => img.path));
    if (!result.success) {
        setCompetitionBusy(false);
        alert('更新竞赛评分失败: ' + result.error);
        return;
    }

    if (result.scores) {
        imageScoresByHash = result.scores;
    }
    if (result.winner) {
        setImageRatingRecord(winner, result.winner.record);
    }
    if (Array.isArray(result.losers)) {
        result.losers.forEach(loserResult => {
            const loser = losers.find(img => img.path === loserResult.path);
            if (loser) {
                setImageRatingRecord(loser, loserResult.record);
            }
        });
    }

    competitionState.pendingWinners.push(winner);
    competitionState.matchIndex += competitionState.groupSize;
    competitionState.currentMatch = null;

    renderImages();
    updateImageCount();
    renderCompetitionMatch();
}

function finishCompetitionRound() {
    if (!competitionState) return;

    const winners = competitionState.pendingWinners;
    if (winners.length === 1) {
        competitionState.champion = winners[0];
        renderCompetitionChampion(winners[0]);
        return;
    }

    competitionState.currentRound = winners;
    competitionState.pendingWinners = [];
    competitionState.roundNumber++;
    competitionState.matchIndex = 0;
    competitionState.currentMatch = null;
    renderCompetitionMatch();
}

function renderCompetitionChampion(champion) {
    const bodyEl = document.getElementById('competitionBody');
    const championEl = document.getElementById('competitionChampion');
    const statusEl = document.getElementById('competitionStatus');
    const imageEl = document.getElementById('competitionChampionImage');
    const nameEl = document.getElementById('competitionChampionName');
    const scoreEl = document.getElementById('competitionChampionScore');

    if (bodyEl) bodyEl.style.display = 'none';
    if (championEl) championEl.style.display = 'flex';
    if (statusEl) {
        statusEl.textContent = `${competitionState.groupSize} 选 1 · ${competitionState.roundLimit} 轮 · ${competitionState.participantCount} 张图片竞赛结束`;
    }
    if (imageEl) {
        imageEl.src = toFileUrl(champion.path);
        imageEl.alt = champion.name;
    }
    if (nameEl) nameEl.textContent = champion.name;
    if (scoreEl) scoreEl.textContent = `当前评分：${formatImageRating(champion)}`;
    setCompetitionBusy(false);
}

function revealCompetitionChampion() {
    if (!competitionState || !competitionState.champion) return;
    window.electronAPI.showInFolder(competitionState.champion.path);
}

function restartImageCompetition() {
    const countInput = document.getElementById('competitionCountInput');
    if (competitionState && countInput) {
        countInput.value = competitionState.roundLimit;
    }
    startImageCompetition();
}

function setCompetitionBusy(isBusy) {
    if (competitionState) {
        competitionState.isBusy = isBusy;
    }
    document.querySelectorAll('.competition-image-btn').forEach(button => {
        button.disabled = isBusy;
    });
}
