/**
 * GitHub 프로필 통계 자동 갱신 스크립트
 *
 * 외부 서비스(github-readme-stats 등)에 의존하지 않고,
 * GitHub GraphQL API에서 직접 수치를 가져와 README.md의
 * <!-- STATS:START --> ~ <!-- STATS:END --> 구간을 다시 씁니다.
 *
 * 실행: GITHUB_TOKEN=... GH_USER=mjayj9 node .github/scripts/update-stats.mjs
 */

import { readFileSync, writeFileSync } from "node:fs";

const USER = process.env.GH_USER || "mjayj9";
const TOKEN = process.env.GITHUB_TOKEN;
const README = "README.md";

if (!TOKEN) {
  console.error("GITHUB_TOKEN 환경변수가 없습니다.");
  process.exit(1);
}

/* ------------------------------------------------------------------ */
/* 1. 데이터 수집                                                       */
/* ------------------------------------------------------------------ */

const QUERY = `
query ($login: String!) {
  user(login: $login) {
    name
    followers { totalCount }
    contributionsCollection {
      totalCommitContributions
      totalPullRequestReviewContributions
      restrictedContributionsCount
      contributionCalendar { totalContributions }
    }
    pullRequests { totalCount }
    issues { totalCount }
    repositories(ownerAffiliations: OWNER, isFork: false, first: 100) {
      totalCount
      nodes { stargazerCount }
    }
  }
}`;

async function fetchStats() {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `bearer ${TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": "profile-stats-updater",
    },
    body: JSON.stringify({ query: QUERY, variables: { login: USER } }),
  });

  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await res.text()}`);

  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));

  const u = json.data.user;
  return {
    // 비공개 저장소 기여(restrictedContributionsCount)는 별도 필드라 직접 더해야 합니다.
    // 이 값이 0으로 나오면 토큰 권한이 없거나, GitHub 프로필 설정에서
    // "Include private contributions on my profile" 이 꺼져 있는 것입니다.
    commits:
      u.contributionsCollection.totalCommitContributions +
      u.contributionsCollection.restrictedContributionsCount,
    privateContributions: u.contributionsCollection.restrictedContributionsCount,
    prs: u.pullRequests.totalCount,
    issues: u.issues.totalCount,
    reviews: u.contributionsCollection.totalPullRequestReviewContributions,
    stars: u.repositories.nodes.reduce((sum, r) => sum + r.stargazerCount, 0),
    followers: u.followers.totalCount,
    repos: u.repositories.totalCount,
    contributions: u.contributionsCollection.contributionCalendar.totalContributions,
  };
}

/* ------------------------------------------------------------------ */
/* 2. 등급 계산                                                         */
/*                                                                     */
/* anuraghazra/github-readme-stats 의 calculateRank 와 동일한 공식.     */
/* 각 지표를 중앙값으로 나눈 뒤 CDF로 0~1 점수화 → 가중평균 → 상위 %.    */
/* ------------------------------------------------------------------ */

// 초반 상승이 빠른 곡선 — 활동량 지표(커밋/PR/이슈/리뷰)에 사용
const exponentialCdf = (x) => 1 - 2 ** -x;

// 천천히 오르는 곡선 — 인기 지표(스타/팔로워)에 사용
const logNormalCdf = (x) => x / (1 + x);

// [표시이름, 값, 중앙값, 가중치, 곡선]
const METRICS = (s) => [
  ["Commits", s.commits, 250, 2, exponentialCdf],
  ["Pull Requests", s.prs, 50, 3, exponentialCdf],
  ["Issues", s.issues, 25, 1, exponentialCdf],
  ["Code Reviews", s.reviews, 2, 1, exponentialCdf],
  ["Stars", s.stars, 50, 4, logNormalCdf],
  ["Followers", s.followers, 10, 1, logNormalCdf],
];

const THRESHOLDS = [1, 12.5, 25, 37.5, 50, 62.5, 75, 87.5, 100];
const LEVELS = ["S", "A+", "A", "A-", "B+", "B", "B-", "C+", "C"];

function calculateRank(stats) {
  const metrics = METRICS(stats);
  const totalWeight = metrics.reduce((sum, [, , , w]) => sum + w, 0);

  const scored = metrics.map(([label, value, median, weight, cdf]) => ({
    label,
    value,
    median,
    weight,
    score: cdf(value / median), // 0 ~ 1
  }));

  const weighted = scored.reduce((sum, m) => sum + m.weight * m.score, 0);
  const percentile = (1 - weighted / totalWeight) * 100; // 낮을수록 상위
  const level = LEVELS[THRESHOLDS.findIndex((t) => percentile <= t)];

  return { level, percentile, scored };
}

/* ------------------------------------------------------------------ */
/* 3. 렌더링                                                            */
/* ------------------------------------------------------------------ */

const BAR_WIDTH = 18;

/** 0~1 점수를 █░ 막대로. */
function bar(score) {
  const filled = Math.round(Math.min(score, 1) * BAR_WIDTH);
  return "█".repeat(filled) + "░".repeat(BAR_WIDTH - filled);
}

/**
 * 등급 사다리를 렌더링하되 현재 등급만 굵게 강조.
 * 예: `S` · `A+` · ... · **`C`**
 */
function ladder(current) {
  return LEVELS.map((l) => (l === current ? `**\`${l}\`**` : `\`${l}\``)).join(" · ");
}
/** 아직 0인 지표를 "다음 목표"로 보여줄 때 쓰는 문구. */
const GOAL_LABELS = {
  Stars: "첫 Star ⭐",
  Followers: "첫 Follower",
  "Code Reviews": "첫 Code Review",
  Issues: "첫 Issue",
  "Pull Requests": "첫 Pull Request",
  Commits: "첫 커밋",
};

/**
 * 표 위에 한 줄로 보여줄 요약 문장 — 지금까지 쌓아온 활동량을 강조합니다.
 *
 * ── 취향에 따라 바꾸기 좋은 부분 ──
 * 예: 이번 달 커밋 수만 보여주거나, 가장 많이 쓴 언어를 덧붙일 수도 있습니다.
 */
function highlight(stats) {
  const parts = [
    `최근 1년간 **${stats.contributions.toLocaleString()}** 개의 컨트리뷰션`,
    `**${stats.commits.toLocaleString()}** 커밋`,
    `**${stats.repos}** 개의 저장소`,
  ];
  if (stats.prs > 0) parts.push(`**${stats.prs}** 개의 Pull Request`);
  return parts.join(" · ");
}

/**
 * 아직 0인 지표들을 "다음 목표" 한 줄로 렌더링.
 * 모두 0이 아니라면 빈 문자열을 반환해 줄 자체를 생략합니다.
 */
function goalLine(pending) {
  if (pending.length === 0) return "";
  const goals = pending.map((m) => GOAL_LABELS[m.label] || m.label).join(" · ");
  return `🎯 **다음 목표** — ${goals}`;
}

function render(stats) {
  const { level, percentile, scored } = calculateRank(stats);
  const today = new Date().toISOString().slice(0, 10);

  // 등급은 6개 지표 전부로 계산하되, 표에는 이미 기록이 있는 지표만 싣습니다.
  // 아직 0인 지표는 아래 "다음 목표" 줄로 따로 보여줍니다.
  let earned = scored.filter((m) => m.value > 0);
  let pending = scored.filter((m) => m.value === 0);

  // 전부 0이면 표가 비어버리므로, 그때는 모든 지표를 그대로 싣습니다.
  if (earned.length === 0) {
    earned = scored;
    pending = [];
  }

  const rows = earned
    .map(
      (m) =>
        `| ${m.label} | \`×${m.weight}\` | **${m.value.toLocaleString()}** | ${m.median.toLocaleString()} | \`${bar(
          m.score,
        )}\` ${(m.score * 100).toFixed(1)}% |`,
    )
    .join("\n");

  const goals = goalLine(pending);

  return [
    highlight(stats),
    "",
    `### 종합 등급 &nbsp;·&nbsp; \`${level}\` &nbsp;·&nbsp; 전 세계 상위 ${percentile.toFixed(1)}%`,
    "",
    ladder(level),
    "",
    "| 지표 | 가중치 | 내 기록 | 기준치 | 달성도 |",
    "| :--- | :---: | ---: | ---: | :--- |",
    rows,
    ...(goals ? ["", goals] : []),
    "",
    `<sub>${today} 기준 · 매일 자동 갱신` +
      (stats.privateContributions > 0
        ? ` · 비공개 저장소 기여 ${stats.privateContributions}개 포함`
        : "") +
      ` · 기준치는 전 세계 GitHub 사용자의 중앙값</sub>`,
  ].join("\n");
}

/* ------------------------------------------------------------------ */
/* 4. README 갱신                                                       */
/* ------------------------------------------------------------------ */

const START = "<!-- STATS:START -->";
const END = "<!-- STATS:END -->";

const stats = await fetchStats();
const block = render(stats);

const readme = readFileSync(README, "utf8");
const startIdx = readme.indexOf(START);
const endIdx = readme.indexOf(END);

if (startIdx === -1 || endIdx === -1) {
  console.error(`README.md 에 ${START} / ${END} 마커가 없습니다.`);
  process.exit(1);
}

const updated =
  readme.slice(0, startIdx + START.length) + "\n\n" + block + "\n\n" + readme.slice(endIdx);

if (updated === readme) {
  console.log("변경 사항 없음.");
} else {
  writeFileSync(README, updated);
  console.log("README.md 갱신 완료.");
}

console.log(JSON.stringify(stats, null, 2));
