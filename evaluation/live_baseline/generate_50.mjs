import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const features = {
  cable: { text: '自带充电线', pattern: '自带线|内置线', query: '自带线' },
  display: { text: '有数字电量显示', pattern: '数显|数字显示|电量显示', query: '数显', detailRequired: true },
  magnetic: { text: '支持磁吸无线充电', pattern: '磁吸|MagSafe', query: '磁吸无线', detailRequired: true },
  cert: { text: '详情可核查3C认证', pattern: '3C认证|CCC认证', query: '3C认证', detailRequired: true },
  dual: { text: '可同时给两台设备充电', pattern: '双口|双输出|多口|同时充', query: '双口 同时充', detailRequired: true },
  triple: { text: '至少三个输出接口', pattern: '三口|多口', query: '三口', detailRequired: true },
  power22: { text: 'USB-C输出至少22.5W', pattern: '(?:22\\.5|25|30|33|45|65|67|100)\\s*W', query: '22.5W', detailRequired: true },
  power30: { text: 'USB-C输出至少30W', pattern: '(?:30|33|45|65|67|100)\\s*W', query: '30W', detailRequired: true },
  power45: { text: 'USB-C PD输出至少45W', pattern: '(?:45|65|67|100)\\s*W', query: 'PD 45W', detailRequired: true },
  power65: { text: 'USB-C输出至少65W', pattern: '(?:65|67|100)\\s*W', query: '65W', detailRequired: true },
  mini: { text: '商品明确标注小巧或口袋款', pattern: '迷你|小巧|口袋', query: '口袋 小巧' },
  lightweight: { text: '重量不超过200g', query: '轻薄 200g', detailRequired: true },
  usbcCable: { text: '自带USB-C充电线', pattern: '自带线.*(?:Type-C|USB-C|C口)|(?:Type-C|USB-C|C口).*自带线', query: '自带线 USB-C', detailRequired: true }
};
// Each profile has five distinct openings and five precommitted hidden goals.
// The design deliberately includes easy, hard and detail-dependent conditions.
const profiles = [
  { scene: '通勤', openers: ['上下班路上想备个充电宝。','每天坐地铁，想买个充电宝。','我想在通勤包里放个充电宝。','工作日出门要带充电宝，帮我看看。','想找个适合日常通勤的移动电源。'], goals: [[10000,'cable',120],[5000,'mini',100],[10000,'power22',140],[10000,'display',150],[10000,'cert',150]] },
  { scene: '出差', openers: ['最近出差频繁，想买个充电宝。','帮我找个商务出行能用的充电宝。','我想给出差的行李配个移动电源。','经常在外办公，想看看充电宝。','想买一个出差途中用的充电宝。'], goals: [[20000,'power45',300],[20000,'cable',250],[20000,'power65',350],[20000,'dual',300],[10000,'lightweight',200]] },
  { scene: '旅游', openers: ['出去旅游想带个充电宝。','假期出门拍照，想备个移动电源。','计划旅行，帮我看看充电宝。','走一天景点怕手机没电，想买个充电宝。','我想为旅行准备一个充电宝。'], goals: [[20000,'cert',200],[10000,'cable',160],[20000,'power30',200],[20000,'dual',250],[10000,'magnetic',180]] },
  { scene: '长辈', openers: ['想给家里长辈买个充电宝。','给父母准备一个移动电源，帮我看看。','老人外出用的充电宝有什么选择？','我想替家人买个容易携带的充电宝。','想给爸爸妈妈买一个备用充电宝。'], goals: [[10000,'cable',160],[10000,'display',180],[20000,'cable',200],[10000,'usbcCable',160],[5000,'mini',130]] },
  { scene: '学生', openers: ['想给上学每天带的手机配个充电宝。','学校里用的充电宝帮我看看。','我是学生，想买个移动电源。','课间给手机补电，想挑个充电宝。','想买个放书包里的充电宝。'], goals: [[10000,'power22',80],[20000,'mini',120],[10000,'cable',100],[10000,'magnetic',160],[20000,'cert',150]] },
  { scene: '露营', openers: ['周末露营想带个充电宝。','户外过夜时想备个移动电源。','帮我看看露营用的充电宝。','在营地给设备补电，想买个充电宝。','我想为短途户外活动准备移动电源。'], goals: [[30000,'dual',250],[30000,'cable',250],[40000,'dual',300],[50000,'cert',300],[30000,'power22',250]] },
  { scene: '办公', openers: ['在办公室和外面切换工作，想买个充电宝。','想给随身办公设备准备移动电源。','经常离开工位开会，想带个充电宝。','帮我挑个办公时用的充电宝。','工作时要给设备补电，想买充电宝。'], goals: [[10000,'power30',180],[20000,'power45',280],[20000,'cable',220],[10000,'magnetic',200],[20000,'dual',220]] },
  { scene: '运动', openers: ['运动出门想带个充电宝。','骑行时手机怕没电，想买个移动电源。','周末跑步后还要出门，想备个充电宝。','健身包里想放一个充电宝。','想买个户外运动时随身带的充电宝。'], goals: [[5000,'mini',100],[10000,'lightweight',180],[10000,'cable',120],[5000,'magnetic',160],[10000,'cert',150]] },
  { scene: '摄影', openers: ['出门拍摄时想备个充电宝。','摄影设备多，帮我看看移动电源。','拍照一整天，想给设备准备充电宝。','经常在外拍视频，想买个充电宝。','想找个拍摄途中补电用的移动电源。'], goals: [[20000,'power30',250],[20000,'dual',220],[30000,'power45',350],[10000,'cable',180],[20000,'display',250]] },
  { scene: '多设备', openers: ['我的随身设备比较多，想买个充电宝。','手机和耳机都要补电，想找移动电源。','出门常带几台设备，帮我看看充电宝。','想买个能给多件数码设备用的充电宝。','平时带手机和平板，想准备充电宝。'], goals: [[20000,'dual',250],[10000,'dual',180],[30000,'triple',300],[20000,'power65',350],[10000,'cable',150]] }
];
const cases = [];
for (const profile of profiles) for (let i = 0; i < 5; i++) {
  const [capacity, featureKey, budget] = profile.goals[i];
  const feature = features[featureKey];
  const capacityCondition = { id: 'capacity', text: `${capacity}mAh`, pattern: `${capacity}\\s*(?:毫安|mAh)` };
  const featureCondition = { id: featureKey, text: feature.text, ...(feature.pattern ? { pattern: feature.pattern } : {}), ...(feature.detailRequired ? { detailRequired: true } : {}) };
  const budgetCondition = { id: 'budget', text: `不超过${budget}元`, maxPrice: budget };
  const hard = [capacityCondition, featureCondition, budgetCondition];
  const feedback = [
    { id: 'capacity', message: `希望容量是${capacity}mAh。`, queryTerm: `${capacity}毫安` },
    { id: featureKey, message: `还需要${feature.text}。`, queryTerm: feature.query },
    { id: 'budget', message: `预算不超过${budget}元。`, maxPrice: budget }
  ];
  cases.push({ id: String(cases.length + 1).padStart(2, '0'), scene: profile.scene,
    initialRequest: profile.openers[i], initialQuery: `充电宝 ${profile.scene}`, hard,
    soft: [], feedback });
}
if (cases.length !== 50 || new Set(cases.map((s) => s.initialRequest)).size !== 50) throw new Error('Invalid 50-case design');
const output = path.join(here, 'scenarios_50.json');
fs.writeFileSync(output, JSON.stringify(cases, null, 2) + '\n');
console.log(`Saved ${cases.length} precommitted scenarios to ${output}`);
