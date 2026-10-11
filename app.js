'use strict';

const issuesContainer = document.getElementById('issues-container');
const connectionStatus = document.getElementById('connection-status');
let socket;
let reconnectDelay = 1000;
let fetchSequence = 0;

function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
}

function field(label, value, useCode = false) {
    const wrapper = element('div', undefined, 'field');
    wrapper.append(element('span', label, 'label'));
    wrapper.append(element(useCode ? 'pre' : 'p', value || 'Not available yet.'));
    return wrapper;
}

function renderMessage(message, className) {
    issuesContainer.replaceChildren(element('p', message, className));
    issuesContainer.setAttribute('aria-busy', 'false');
}

function renderIssue(issue) {
    const card = element('article', undefined, `issue-card ${issue.analysis_status || ''}`);
    card.id = issue.query_hash;
    card.append(element('h2', 'Slow query detected'));
    card.append(field('Query', issue.query_text, true));
    const seconds = Number(issue.execution_time_sec);
    card.append(field('Longest observed execution', Number.isFinite(seconds) ? `${seconds.toFixed(2)} seconds` : 'Unknown'));
    const seenAt = new Date(issue.last_seen);
    card.append(field('Last seen', Number.isNaN(seenAt.getTime()) ? 'Unknown' : seenAt.toLocaleString()));

    if (issue.analysis_status === 'pending') {
        card.append(element('p', 'AI analysis is in progress. This page will update automatically.', 'status'));
    } else if (issue.analysis_status === 'failed') {
        card.append(element('p', 'AI analysis is unavailable. It will be retried if this slow query appears again.', 'error'));
    } else {
        card.append(element('h3', 'AI analysis'));
        card.append(field('Summary', issue.summary));
        card.append(field('Recommendation', issue.recommendation, true));
        card.append(field('Optimized query', issue.optimized_query, true));
    }

    const button = element('button', 'Mark as solved and get next');
    button.type = 'button';
    button.addEventListener('click', () => solveIssue(issue.query_hash, button));
    card.append(button);
    issuesContainer.replaceChildren(card);
    issuesContainer.setAttribute('aria-busy', 'false');
}

async function fetchNextIssue() {
    const sequence = ++fetchSequence;
    issuesContainer.setAttribute('aria-busy', 'true');
    try {
        const response = await fetch('/issues/next', { headers: { accept: 'application/json' } });
        if (!response.ok) throw new Error(`Server returned HTTP ${response.status}`);
        const issue = await response.json();
        if (sequence !== fetchSequence) return;
        if (issue) renderIssue(issue);
        else renderMessage('All issues are solved.');
    } catch (error) {
        console.error('Could not fetch issue:', error);
        if (sequence === fetchSequence) renderMessage('Could not load issues from the server.', 'error');
    }
}

async function solveIssue(hash, button) {
    button.disabled = true;
    try {
        const response = await fetch(`/issues/${encodeURIComponent(hash)}/solve`, { method: 'POST' });
        if (!response.ok) throw new Error(`Server returned HTTP ${response.status}`);
        await fetchNextIssue();
    } catch (error) {
        console.error('Could not solve issue:', error);
        button.disabled = false;
        connectionStatus.textContent = 'Could not mark the issue as solved. Please try again.';
        connectionStatus.className = 'status error';
    }
}

function connectWebSocket() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    socket = new WebSocket(`${protocol}//${location.host}`);
    socket.addEventListener('open', () => {
        reconnectDelay = 1000;
        connectionStatus.textContent = 'Connected. Listening for live updates.';
        connectionStatus.className = 'status';
    });
    socket.addEventListener('message', (event) => {
        try {
            const data = JSON.parse(event.data);
            if (data.message === 'issue_changed') void fetchNextIssue();
        } catch (error) {
            console.warn('Ignored an invalid WebSocket message:', error);
        }
    });
    socket.addEventListener('close', () => {
        connectionStatus.textContent = 'Live updates disconnected. Reconnecting…';
        connectionStatus.className = 'status error';
        window.setTimeout(connectWebSocket, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, 30000);
    });
    socket.addEventListener('error', () => socket.close());
}

void fetchNextIssue();
connectWebSocket();
