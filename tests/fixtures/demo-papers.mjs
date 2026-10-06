// Deterministic, invented bibliography used by browser tests, screenshots and the demo video.
// DOIs use the 10.5555 prefix that Crossref reserves for examples; none of them resolve.
const TOPICS = [
  ['Soil microbial networks under long-term nitrogen addition', 'ecology'],
  ['Transformer models for protein–ligand binding affinity', 'bioinformatics'],
  ['城市热岛效应与夜间睡眠质量的关联研究', 'public-health'],
  ['Perovskite solar cells with self-healing grain boundaries', 'materials'],
  ['Hippocampal replay during quiet wakefulness in mice', 'neuroscience'],
  ['A randomized trial of text-message reminders for hypertension care', 'medicine'],
  ['基于多源遥感的黄河流域植被恢复评估', 'remote-sensing'],
  ['Coastal wetland carbon burial across a salinity gradient', 'ecology'],
  ['Graph neural networks for traffic forecasting: a systematic review', 'computing'],
  ['Periodic mesoporous silica as a drug carrier for oral delivery', 'materials'],
  ['肠道菌群与2型糖尿病：一项孟德尔随机化研究', 'medicine'],
  ['Measuring reading fluency with eye-tracking in bilingual children', 'education'],
  ['Thermal tolerance of reef-building corals after repeated bleaching', 'ecology'],
  ['Low-cost air quality sensors calibrated with gradient boosting', 'environment'],
  ['Single-cell atlas of the developing human retina', 'biology'],
  ['乡村振兴背景下数字普惠金融的减贫效应', 'economics'],
  ['Mechanical metamaterials with programmable stiffness', 'engineering'],
  ['Sleep spindles predict overnight memory consolidation in older adults', 'neuroscience'],
  ['Microplastic ingestion by freshwater fish in the Yangtze basin', 'environment'],
  ['Federated learning for medical imaging across 14 hospitals', 'computing'],
  ['Ancient DNA reveals early millet farming in northern China', 'archaeology'],
  ['Lithium-sulfur batteries with redox-mediating separators', 'materials'],
  ['School gardens and children’s vegetable intake: a cluster trial', 'public-health'],
  ['青藏高原多年冻土活动层厚度的长期变化', 'geoscience'],
  ['Uncertainty estimates for deep learning weather emulators', 'computing'],
  ['Pollinator decline and crop yield stability in smallholder farms', 'ecology'],
  ['CRISPR base editing corrects a hereditary hearing-loss mutation', 'biology'],
  ['Heat waves and emergency admissions among adults over 65', 'medicine'],
  ['Sediment transport in braided rivers measured with drone photogrammetry', 'geoscience'],
  ['大语言模型辅助文献综述的可靠性评估', 'computing'],
  ['Antibiotic resistance genes in hospital wastewater treatment plants', 'environment'],
  ['A cohort study of screen time and myopia progression in adolescents', 'medicine'],
  ['Self-assembled peptide hydrogels for cartilage repair', 'materials'],
  ['Biodiversity offsets in road construction: evidence from 52 projects', 'policy'],
  ['Gut–brain signalling through vagal afferents regulates satiety', 'neuroscience'],
  ['碳排放权交易对企业绿色创新的影响', 'economics'],
  ['Wind turbine wake steering with reinforcement learning', 'engineering'],
  ['Long COVID symptom clusters in a national primary care database', 'medicine'],
  ['Phosphorus recovery from struvite in decentralized sanitation', 'environment'],
  ['Teacher feedback timing and student revision quality in writing', 'education'],
];
const REASONS = {
  failed: [
    '网站明确提示未找到或未收录该文献。',
    '文件已下载，但 MIME 为 text/html，不能确认是 PDF；请人工检查。',
    '检索页面加载失败：net::ERR_CONNECTION_RESET',
    '结果识别超过 12 秒仍无法判断，记为未确认，可重试。',
  ],
};

function doiFor(index) {
  return `10.5555/demo.${2018 + (index % 7)}.${String(10000 + index * 37).slice(-5)}`;
}

/** Plain bibliography records, as an importer would produce them. */
export function createDemoBibliography(count = 2174, {missingEvery = 14} = {}) {
  return Array.from({length: count}, (_, offset) => {
    const index = offset + 1;
    const [topic] = TOPICS[offset % TOPICS.length];
    const round = Math.floor(offset / TOPICS.length);
    const title = round ? `${topic}${/[一-鿿]/.test(topic) ? `（续${round}）` : ` — cohort ${round + 1}`}` : topic;
    const sourceIndex = String(index).padStart(4, '0');
    const missing = index % missingEvery === 0;
    return {id: `paper-${sourceIndex}`, sourceIndex, title, doi: missing ? '' : doiFor(index), sourceStatus: missing ? '[原文未列出 DOI]' : '[原文提供]'};
  });
}

/** A queue mid-run: roughly 60% downloaded, a few failures, one paper being searched. */
export function decorateDemoProgress(papers, {done = 0.62, activeIndex = null} = {}) {
  const eligible = papers.filter(p => p.doi || p.pdfUrl);
  const cutoff = Math.round(eligible.length * done);
  let seen = 0;
  return papers.map((paper, offset) => {
    if (!paper.doi && !paper.pdfUrl) return {...paper, status: 'missing_doi', attempts: 0, reason: '缺少可用 DOI / PDF 直链，未尝试下载；普通网页入口需人工打开。'};
    seen += 1;
    if (activeIndex !== null && offset === activeIndex) return {...paper, status: 'searching', attempts: 1, reason: ''};
    if (seen > cutoff) return {...paper, status: 'pending', attempts: 0, reason: ''};
    if (seen % 17 === 0) return {...paper, status: 'failed', attempts: 1, reason: REASONS.failed[seen % REASONS.failed.length]};
    const safeTitle = paper.title.replace(/[<>:"/\\|?*]/g, '_').slice(0, 72);
    return {...paper, status: 'success', attempts: 1, reason: '浏览器已确认下载完成，PDF MIME 与文件大小检查通过。', filename: `LiteratureBatch/${paper.sourceIndex}_${safeTitle}_${paper.doi.replace('/', '_')}.pdf`};
  });
}
