import type { StringTable } from './types';

/**
 * Korean display text.
 *
 * Same keys as `en.ts`, same content, different words. Descriptions are translated rather
 * than transliterated: the English ones are written to convey a *feel* alongside the numbers
 * - dry, a bit grim - and a literal rendering loses that while gaining nothing.
 *
 * Names deliberately stay short. Several are read inside a sentence the interface builds
 * (`{name} 채집`) or on a label pinned over a sprite, so a faithful-but-long name would wrap
 * or overflow where the English one did not.
 */
export const KO: StringTable = {
  items: {
    alcohol_moonshine: {
      name: '밀주',
      description: '과일 발효액을 증류기에 통과시킨 것. 진통제, 소독약, 그리고 형편없는 발상.',
    },
    ammo_308: {
      name: '.308 탄',
      description: '전력 소총 탄. 여섯 발이면 계획이라 부를 만하다.',
    },
    ammo_9mm: {
      name: '9mm 탄',
      description: '예전엔 흔했고 지금은 귀하다.',
    },
    ammo_casing: {
      name: '탄피',
      description: '인발한 황동. 뇌관과 장약을 넣고 물릴 준비가 됐다.',
    },
    ammo_shell: {
      name: '산탄 탄',
      description: '플라스틱 탄피, 황동 밑판, 한 줌의 납.',
    },
    antibiotics: {
      name: '항생제',
      description: '짧은 한 코스. 패혈증을 확실히 멈추는 유일한 것.',
    },
    antiseptic: {
      name: '소독약',
      description: '배신처럼 쓰라리다. 상처에 하루의 여유를 사준다.',
    },
    anvil_kit: {
      name: '모루 키트',
      description: '그루터기에 얹은 철 덩이. 터무니없이 무겁고, 강철에는 필요하다.',
    },
    apple: {
      name: '사과',
      description: '한쪽이 멍들었다. 그래도 사과다.',
    },
    arrow_iron: {
      name: '철 화살',
      description: '촉이 무거워 가죽 재킷과 그 안에 든 것까지 뚫는다.',
    },
    arrow_wooden: {
      name: '나무 화살',
      description: '불로 굳힌 대에 부싯돌 촉. 보통은 다시 뽑아 쓸 수 있다.',
    },
    backpack_large: {
      name: '큰 배낭',
      description: '등산용 프레임 배낭. 열여섯 칸, 그리고 그 무게가 전부 느껴진다.',
    },
    backpack_small: {
      name: '작은 배낭',
      description: '주머니 여덟 개가 늘어난다. 이 게임에서 삶의 질이 가장 크게 오르는 순간.',
    },
    baked_potato: {
      name: '구운 감자',
      description: '껍질엔 재, 속엔 김.',
    },
    bandage_clean: {
      name: '깨끗한 붕대',
      description: '끓여서 햇볕에 말린 천. 천 조각보다 압도적으로 낫다.',
    },
    bandage_dirty: {
      name: '더러운 붕대',
      description: '찢은 천을 단단히 감았다. 피는 멈추고 감염은 불러들인다.',
    },
    bandage_sterile: {
      name: '멸균 드레싱',
      description: '밀봉된 소독 거즈. 그 뒤로는 아무것도 들어가지 못한다.',
    },
    bark: {
      name: '나무껍질',
      description: '벗겨낸 껍질. 가죽 무두질용 타닌이자 불씨 감.',
    },
    baseball_bat: {
      name: '야구 방망이',
      description: '물푸레나무, 테이프 감은 손잡이, 남이 새겨둔 이름 머리글자.',
    },
    battery: {
      name: '배터리',
      description: '충전이 얼마간 남았다. 라디오와 손전등에만.',
    },
    beans: {
      name: '콩',
      description: '덩굴을 올려주면 한 철 내내 계속 열린다.',
    },
    bed_kit: {
      name: '침대 키트',
      description: '골조와 살대, 속을 채운 매트리스. 잠은 밤을 되찾는 방법이다.',
    },
    berry: {
      name: '산딸기',
      description: '덤불에서 한 줌. 달고 촉촉하고, 순식간에 사라진다.',
    },
    bolt: {
      name: '석궁 볼트',
      description: '짧고 굵고 악랄하다. 회수해 쓰도록 만들어졌다.',
    },
    bone: {
      name: '뼈',
      description: '튼튼하고, 쪼개면 날카롭다. 태워 재로 만들면 비료와 화약이 된다.',
    },
    bread: {
      name: '빵',
      description: '촘촘한 납작 빵. 며칠을 가고, 재배할 수 있는 무엇보다 배를 채운다.',
    },
    cabbage: {
      name: '양배추',
      description: '잎이 빽빽한 한 통. 다른 건 다 죽는 서리를 견딘다.',
    },
    campfire_kit: {
      name: '모닥불 키트',
      description: '돌을 둥글게 놓고 불씨 감을 묶었다. 빛, 온기, 요리, 안전.',
    },
    canned_beans: {
      name: '통조림 콩',
      description: '찌그러졌지만 밀봉은 멀쩡하다. 누군가 찬장을 채우고 끝내 돌아오지 않았다.',
    },
    canned_soup: {
      name: '통조림 수프',
      description: '깡통에서 차게 먹어도 그 주의 최고 순간이다.',
    },
    canteen: {
      name: '수통',
      description: '금속에 펠트를 씌웠고 여섯 번 분량. 닿을 수 있는 물이면 어디서든 채운다.',
    },
    carrot: {
      name: '당근',
      description: '아삭하고 놀랄 만큼 달다.',
    },
    charcoal: {
      name: '숯',
      description: '공기를 막고 익힌 나무. 제련 연료이자 화약의 검은 절반.',
    },
    chemistry_bench_kit: {
      name: '화학 작업대 키트',
      description: '유리 기구, 버너, 주워 온 작업판. 약과 화약.',
    },
    chocolate_bar: {
      name: '초콜릿 바',
      description: '오래돼 회색으로 피었다. 설탕은 설탕이다.',
    },
    clay: {
      name: '점토',
      description: '강가에서 파낸 젖은 회색 점토. 지금은 모르타르, 구우면 벽돌.',
    },
    clay_brick: {
      name: '점토 벽돌',
      description: '가마에 구워 단단하다. 갈라지지 않고 화구를 감싼다.',
    },
    cloth: {
      name: '천',
      description: '짜낸 네모 조각. 옷, 붕대, 배낭.',
    },
    cloth_pants: {
      name: '천 바지',
      description: '섬유를 짜서 만든 두 가랑이를 끈으로 붙든다.',
    },
    cloth_rag: {
      name: '천 조각',
      description: '찢어진 천 쪼가리. 더럽지만 피는 잘 먹는다.',
    },
    cloth_shirt: {
      name: '천 셔츠',
      description: '손으로 짜서 형태가 없다. 맨살보다 낫긴 하다, 간신히.',
    },
    coal: {
      name: '석탄',
      description: '재배할 수 있는 무엇보다 뜨겁고 오래 타는 검은 암석.',
    },
    coffee: {
      name: '커피',
      description: '묵은 가루를 두 번 끓였다. 벌지 않은 한 시간을 사준다.',
    },
    compass: {
      name: '나침반',
      description: '날씨가 어떻든 북쪽을 가리킨다. 제자리를 도는 것에 대한 값싼 보험.',
    },
    compost: {
      name: '퇴비',
      description: '한 철 모은 부엌 찌꺼기가 검고 달게 삭았다.',
    },
    cooked_fish: {
      name: '구운 생선',
      description: '살이 부스러지고 짜다. 조용히, 정직하게 얻은 음식.',
    },
    cooked_meat: {
      name: '구운 고기',
      description: '겉은 그슬리고 속까지 뜨겁다. 불을 지키는 가장 큰 이유.',
    },
    cooking_pot_kit: {
      name: '요리 냄비',
      description: '두들겨 만든 철 냄비와 삼각대. 수프, 스튜, 그리고 물을 한꺼번에.',
    },
    copper_ingot: {
      name: '구리 주괴',
      description: '부드럽고 전기가 통하고 다루기 쉽다. 철사와 탄피 황동.',
    },
    copper_ore: {
      name: '구리 광석',
      description: '초록 줄이 간 암석. 무른 금속이지만 철사가 되고 탄피가 된다.',
    },
    corn: {
      name: '옥수수',
      description: '묵직한 이삭에 밝은 알. 식량이자 사료이자 모든 증류의 밑감.',
    },
    crossbow: {
      name: '석궁',
      description: '당기는 데 오래 걸리고, 놓는 순간 잔혹하고, 소리는 거의 없다.',
    },
    crowbar: {
      name: '쇠지레',
      description: '우선은 지렛대, 다음이 무기. 어느 쪽도 아주 나쁘진 않다.',
    },
    disinfected_rag: {
      name: '소독한 천 조각',
      description: '소독약에 적신 천. 야전용이지만 효과는 있다.',
    },
    door_key: {
      name: '문 열쇠',
      description:
        '어딘가의 자물쇠 하나에 맞춰 깎였다. 어딘지 알아낼 때까지는 들고 다닐 값이 있다.',
    },
    dough: {
      name: '반죽',
      description: '밀가루와 물을 반죽했다. 불 하나만 있으면 빵이 된다.',
    },
    duct_tape: {
      name: '덕트 테이프',
      description: '반 롤 남았다. 무엇이든 고친다, 한 번은.',
    },
    egg: {
      name: '달걀',
      description: '둥지에서 갓 꺼내 따뜻하다. 돌이 가득한 배낭에서는 위태롭다.',
    },
    energy_bar: {
      name: '에너지 바',
      description: '맛은 종이 같고 효과는 따귀 같다. 뛰면서 먹어라.',
    },
    farm_plot_kit: {
      name: '밭 키트',
      description: '테두리 판자와 좋은 흙 한 자루. 맨땅을 작물 자리로 바꾼다.',
    },
    feather: {
      name: '깃털',
      description: '화살 깃. 이게 없으면 화살은 대충 앞으로 가는 막대일 뿐이다.',
    },
    fertilizer: {
      name: '비료',
      description: '골분과 삭은 풀. 수확이 빼앗아 간 땅의 힘을 되사준다.',
    },
    first_aid_kit: {
      name: '구급상자',
      description: '초록 상자, 흰 십자, 세 번 남음. 처음으로 모든 게 한자리에 있다.',
    },
    fishing_rod: {
      name: '낚싯대',
      description: '막대, 줄, 구부린 못. 가만히 앉아 있을 수 있다면 조용한 식량.',
    },
    flashlight: {
      name: '손전등',
      description: '좁은 빛 원뿔과 늘 거의 다 된 배터리.',
    },
    flint: {
      name: '부싯돌',
      description: '깎으면 면도날처럼 서고 부딪히면 불꽃이 튄다. 문제 둘, 돌 하나.',
    },
    flour: {
      name: '밀가루',
      description: '밀을 연마석에 통과시킨 것. 그냥도 먹을 수 있다, 모래가 그런 식으로.',
    },
    fuel_canister: {
      name: '연료통',
      description: '휘발유 한 통, 삭아가지만 여전히 맹렬하다. 가진 무엇보다 뜨겁게 탄다.',
    },
    furnace_kit: {
      name: '용광로 키트',
      description: '다듬은 석재와 내벽용 생점토. 철은 여기서 시작한다.',
    },
    gas_mask: {
      name: '방독면',
      description: '필터는 아직 쓸 만하다. 숨쉬는 것만 도와주는데, 때로는 그게 전부다.',
    },
    glass: {
      name: '판유리',
      description: '평평하게 부어 천천히 식혔다. 창, 등불, 병.',
    },
    glass_shard: {
      name: '유리 조각',
      description: '깨진 날. 겨눈 것만큼이나 쥔 손도 자주 벤다.',
    },
    grindstone_kit: {
      name: '연마석 키트',
      description: '다듬은 숫돌과 크랭크. 밀은 밀가루로, 날은 다시 날카롭게.',
    },
    gunpowder: {
      name: '화약',
      description: '숯, 초석, 골회를 곱게 갈았다. 마른 채로 조심히 다뤄라.',
    },
    hammer: {
      name: '망치',
      description: '못을 박고 돌을 다듬고 말다툼을 끝낸다.',
    },
    hard_hat: {
      name: '안전모',
      description: '공사장 헬멧. 떨어지는 벽돌용으로 만들어졌지만 지금은 떨어지는 이빨용이다.',
    },
    herb: {
      name: '약초',
      description: '쓴 잎. 우려서 통증에, 으깨서 상처에, 곰팡이를 피워 항생제에.',
    },
    hide: {
      name: '동물 가죽',
      description: '날것이고 기름지고 냄새가 나기 시작했다. 상하기 전에 무두질해라.',
    },
    hoe: {
      name: '괭이',
      description: '떼를 부숴 씨앗 자리를 만든다. 농사는 이걸로 시작하거나 아예 시작되지 않는다.',
    },
    hunting_bow: {
      name: '수렵용 활',
      description: '막대, 힘줄, 인내심. 거리에 알리지 않고 사슴과 보행자를 잡는다.',
    },
    iron_axe: {
      name: '철 도끼',
      description: '제대로 된 벌목 도끼. 나무 한 그루가 오후에서 1분으로 줄어든다.',
    },
    iron_ingot: {
      name: '철 주괴',
      description: '제련한 철. 겨우 버티는 것과 뭔가를 세우는 것 사이의 선.',
    },
    iron_knife: {
      name: '철 칼',
      description: '얇고 빠르고 날이 오래 선다. 도축과 뒷골목.',
    },
    iron_ore: {
      name: '철 광석',
      description: '녹슨 붉은 암석. 용광로 없이는 쓸모없고 있으면 값을 매길 수 없다.',
    },
    iron_pickaxe: {
      name: '철 곡괭이',
      description: '철과 구리를 열어주는 도구. 금속으로 된 모든 것이 이것 뒤에 있다.',
    },
    iron_sword: {
      name: '철검',
      description: '손에 있는 것으로 벼려낸, 누군가가 생각한 검. 어쨌든 잘 든다.',
    },
    jeans: {
      name: '청바지',
      description: '데님. 이럴 자격이 없을 만큼 튼튼하다.',
    },
    jerky: {
      name: '육포',
      description: '약한 불에 몇 시간을 말렸다. 보기 흉하고 질기고, 썩지 않는다.',
    },
    kevlar_vest: {
      name: '방탄 조끼',
      description: '나일론 겉감 안에 연질 방탄재. 총알은 막지만 팔에는 아무 도움이 안 된다.',
    },
    kitchen_knife: {
      name: '부엌칼',
      description: '누군가의 서랍에서 나왔다. 양파에는 훌륭하고 그보다 큰 것에는 솔직하다.',
    },
    lantern: {
      name: '등불',
      description: '유리, 심지, 기름통. 횃불보다 밝고 훨씬 오래간다.',
    },
    leather: {
      name: '가죽',
      description: '무두질한 피혁. 물린 상처를 멍으로 바꿔주는 편이 더 많다.',
    },
    leather_cap: {
      name: '가죽 모자',
      description: '긁힘을 막고 비를 가린다. 그게 전부다.',
    },
    leather_gloves: {
      name: '가죽 장갑',
      description: '가시와 유리, 그리고 이따금의 이빨로부터 손을 지킨다.',
    },
    leather_jacket: {
      name: '가죽 재킷',
      description: '두꺼운 가죽에 긴 소매. 이빨이 내 살 대신 여기에 걸린다.',
    },
    leather_pants: {
      name: '가죽 바지',
      description: '딱딱하고 덥고 물어 뚫기 어렵다. 기어다니는 것들은 다리를 노린다.',
    },
    lighter: {
      name: '라이터',
      description: '몇십 번 켤 만큼 남았다. 비 오는 밤에는 보이는 것보다 값이 나간다.',
    },
    lockpick: {
      name: '자물쇠 따개',
      description: '구부린 철사와 텐션 바. 내가 짓지 않은 것을 연다, 때때로.',
    },
    loom_kit: {
      name: '직조기 키트',
      description: '골조, 바디, 잉아. 섬유는 천이 되고 가죽은 무두질된다.',
    },
    machete: {
      name: '마체테',
      description: '길고 끝이 무겁다. 팔꿈치에서 팔을 떼어낸다.',
    },
    map: {
      name: '지역 지도',
      description: '접힌 자리마다 찢어졌다. 지나가는 대로 주변 땅이 드러난다.',
    },
    molotov: {
      name: '화염병',
      description: '병 하나, 천 하나, 그리고 나쁜 발상. 1분간 문간을 불로 막는다.',
    },
    morphine: {
      name: '모르핀',
      description: '한 앰풀. 고통을 완전히 지운다, 판단력까지 함께.',
    },
    motorcycle_helmet: {
      name: '오토바이 헬멧',
      description: '풀페이스에 색이 든 실드. 하루 종일 물어도 된다.',
    },
    multitool: {
      name: '멀티툴',
      description: '붕괴 이전 합금이라 관절이 아직 단단하다. 주머니 속 네 가지 도구, 대체 불가.',
    },
    mushroom: {
      name: '야생 버섯',
      description: '아마도 먹을 수 있는 종류다. 아마도.',
    },
    nail: {
      name: '못',
      description: '작고 무디고, 지붕이 안 날아가는 이유.',
    },
    nail_bat: {
      name: '못 박은 방망이',
      description: '방망이에 못 열두 개를 박았다. 뺄 때마다 살이 찢긴다.',
    },
    onion: {
      name: '양파',
      description: '날로는 톡 쏘고, 냄비에 들어가면 완전히 달라진다.',
    },
    painkiller: {
      name: '진통제',
      description: '흰 알약 두 알. 통증은 조용해지지만 부상은 그대로다.',
    },
    pistol_9mm: {
      name: '9mm 권총',
      description: '열다섯 발과 아주 큰 목소리. 네 청크 안의 모든 것이 듣는다.',
    },
    pitchfork: {
      name: '쇠스랑',
      description: '갈래 넷에 농기구 길이 손잡이. 하나를 꿰고 둘을 밀어낸다.',
    },
    plant_fiber: {
      name: '식물 섬유',
      description: '질긴 줄기. 누구나 처음 모으는 것이자 마지막까지 떨어지지 않는 것.',
    },
    plastic: {
      name: '플라스틱 조각',
      description: '갈라진 패널과 병 몸통. 가볍고 물에 안 젖고 어디에나 있다.',
    },
    plate_carrier: {
      name: '방탄판 조끼',
      description: '앞뒤로 세라믹 판. 무겁고 덥고, 그리고 최고의 선택.',
    },
    potato: {
      name: '감자',
      description: '흙이 붙었고 묵직하다. 어디서나 자라고 오래 가고 아무 맛도 없다.',
    },
    pumpkin: {
      name: '호박',
      description: '터무니없이 무겁고 터무니없이 배부르다. 2주를 들일 값이 있다.',
    },
    radio: {
      name: '라디오',
      description: '대부분 잡음. 간간이 사람 목소리, 그러면 결정을 내려야 한다.',
    },
    raw_fish: {
      name: '생선',
      description: '아직 미끈하다. 급하면 뼈까지.',
    },
    raw_meat: {
      name: '생고기',
      description: '손질했고 피가 흐른다. 열에 시달리는 꿈을 즐기지 않으면 익혀라.',
    },
    resin: {
      name: '송진',
      description: '끈끈한 수액. 접착제, 방수, 그리고 횃불을 제대로 태운다.',
    },
    rifle_308: {
      name: '.308 수렵용 소총',
      description: '들판을 가로질러 논쟁을 끝낸다. 그리고 들판이 가득 찬다.',
    },
    rope: {
      name: '밧줄',
      description: '섬유를 꼬아 만든 줄. 결속, 활줄, 덫.',
    },
    rubber: {
      name: '고무',
      description: '타이어 측면에서 잘라냈다. 밀폐, 끈, 새총 밴드.',
    },
    sand: {
      name: '모래',
      description: '규사. 녹기 전까지는 쓸모없다.',
    },
    saw: {
      name: '톱',
      description: '통나무를 쪼갠 조각이 아니라 판자로 만든다.',
    },
    schematic_ammunition: {
      name: '도해: 탄약 재장전',
      description: '설명서에서 찢어낸 재장전 표. 장약량, 크림프, 착탄 깊이.',
    },
    schematic_crossbow: {
      name: '도해: 석궁',
      description: '활대와 너트, 방아쇠 도면. 조용하고 치명적이며 눈에 띄지 않는다.',
    },
    schematic_medicine: {
      name: '도해: 야전 약국',
      description: '정갈한 필체의 배양 기록. 항아리에서 치료제를 키우는 법.',
    },
    schematic_steel: {
      name: '도해: 도가니 강철',
      description: '물에 얼룩진 침탄 기록. 누군가가 쏟은 여러 시간.',
    },
    scrap_metal: {
      name: '고철',
      description: '옛 세계의 뒤틀린 자재. 다시 제련하거나 어딘가에 못질해라.',
    },
    seed_beans: {
      name: '콩 씨앗',
      description: '올라갈 것을 주면 계속 돌려준다.',
    },
    seed_cabbage: {
      name: '양배추 씨앗',
      description: '추위에 강하다. 가을에 마지막까지 자라는 것.',
    },
    seed_carrot: {
      name: '당근 씨앗',
      description: '먼지처럼 고운 씨. 빽빽이 뿌리고 나중에 솎아라.',
    },
    seed_corn: {
      name: '옥수수 씨앗',
      description: '말린 알. 느리고 무겁지만 값을 한다.',
    },
    seed_herb: {
      name: '약초 씨앗',
      description: '야생 약초의 씨. 약장의 시작.',
    },
    seed_onion: {
      name: '양파 종구',
      description: '다시 땅에 넣을 준비가 된 작은 구근.',
    },
    seed_potato: {
      name: '씨감자',
      description: '눈을 살려 자른 싹 난 덩이.',
    },
    seed_pumpkin: {
      name: '호박 씨앗',
      description: '납작한 흰 씨. 자리와 한 철이 통째로 필요하다.',
    },
    seed_tomato: {
      name: '토마토 씨앗',
      description: '익은 열매에서 긁어내 종이에 말렸다.',
    },
    seed_wheat: {
      name: '밀 씨앗',
      description: '지난 수확에서 덜어둔 한 손의 알곡.',
    },
    shotgun: {
      name: '펌프 산탄총',
      description: '근거리에서 즉각적인 후회 여덟 알. 동시에 저녁 종.',
    },
    shovel: {
      name: '삽',
      description: '점토와 모래, 그리고 무덤을 판다.',
    },
    sickle: {
      name: '낫',
      description: '곡식과 섬유를 한 줌이 아니라 한 아름씩 거둔다.',
    },
    sinew: {
      name: '힘줄',
      description: '말린 힘줄. 풀로 꼰 어떤 줄보다 강하다.',
    },
    sledgehammer: {
      name: '대형 망치',
      description: '한 철처럼 느리지만 맞은 것은 다시 일어나지 않는다. 문도 포함해서.',
    },
    soda: {
      name: '탄산음료',
      description: '김이 빠지고 미지근하고, 설탕 40그램.',
    },
    soup_vegetable: {
      name: '채소 수프',
      description: '밭에 있던 것을 형태가 없어질 때까지 끓였다. 뜨겁고 촉촉하고 무엄청 반갑다.',
    },
    spear: {
      name: '창',
      description: '거리. 되돌릴 수 없는 한 입과 나 사이에 있는 유일한 것.',
    },
    splint_medical: {
      name: '의료용 부목',
      description: '패드를 댄 합금 지지대와 제대로 된 끈. 골절을 고정하고 걷게 해준다.',
    },
    splint_wood: {
      name: '나무 부목',
      description: '막대 둘과 천 한 장. 형편없이 고정하지만 안 하는 것보다는 낫다.',
    },
    steel_axe: {
      name: '강철 도끼',
      description: '벼리고 담금질하고 균형까지 맞췄다. 철보다 깊이 박히고 흠집도 안 난다.',
    },
    steel_ingot: {
      name: '강철 주괴',
      description: '뜨거운 불에서 철이 탄소와 맺어졌다. 무리 하나를 상대해도 날이 선다.',
    },
    steel_pickaxe: {
      name: '강철 곡괭이',
      description: '경화한 촉과 탄성 있는 자루. 큰 바위가 한 줌씩 떨어져 나간다.',
    },
    stew_meat: {
      name: '고기 스튜',
      description: '고기와 뿌리채소와 국물. 나흘간 산딸기만 먹은 뒤라면 세상 최고의 한 끼.',
    },
    stick: {
      name: '나뭇가지',
      description: '다듬은 가지. 손잡이, 대, 불씨 감.',
    },
    stone: {
      name: '돌',
      description: '손에 쥘 만한 돌. 베일 만큼 날카롭고 쌓을 만큼 무겁다.',
    },
    stone_block: {
      name: '석재',
      description: '다듬은 석공재. 무겁고 만들기 느리고, 타지 않는다.',
    },
    stone_hatchet: {
      name: '돌 손도끼',
      description: '가지에 돌 조각을 묶었다. 나무를 넘기기는 하고, 그러다 부서진다.',
    },
    stone_knife: {
      name: '돌 칼',
      description: '부싯돌을 쳐서 낸 날. 가죽을 벗기고 깎고, 그러다 닳는다.',
    },
    stone_pickaxe: {
      name: '돌 곡괭이',
      description: '무디고 잘 깨진다. 작은 돌과 석탄에는 충분하지만 광석에는 어림없다.',
    },
    storage_box_kit: {
      name: '보관 상자 키트',
      description: '납작하게 포장된 상자. 등에 지지 않는 스무 칸.',
    },
    suture_kit: {
      name: '봉합 키트',
      description: '바늘, 힘줄, 그리고 떨리지 않는 손. 붕대가 덮기만 하는 것을 닫는다.',
    },
    tea_herbal: {
      name: '약초차',
      description: '버드나무 껍질과 쓴 잎. 통증의 날을 무디게 한다.',
    },
    throwing_rock: {
      name: '던질 돌',
      description: '균형을 봐서 고른 주먹만 한 돌. 거의 아프지 않지만 내가 없는 곳에 떨어진다.',
    },
    tomato: {
      name: '토마토',
      description: '잘못 쳐다보면 터진다. 대부분 물이고, 그게 요점이다.',
    },
    tool_belt: {
      name: '공구 벨트',
      description:
        '허리에 가죽 고리 넷. 배낭보다 칸은 적지만 등이 무겁지 않고, 첫날에 만들 수 있다.',
    },
    torch: {
      name: '횃불',
      description: '막대에 송진을 적신 섬유. 들면 길을 비추고, 벽에 박으면 방을 비춘다.',
    },
    vitamins: {
      name: '비타민',
      description: '분필 같은 알약이 든 병. 느리고 지루하고, 진짜로 쓸모 있다.',
    },
    water_barrel_kit: {
      name: '물통 키트',
      description: '널판과 테와 송진. 비를 받아 못까지 걸어갈 일을 없앤다.',
    },
    water_bottle: {
      name: '물병',
      description: '긁힌 플라스틱에 나사 뚜껑. 들고 다니는 네 모금의 안전.',
    },
    water_clean: {
      name: '깨끗한 물',
      description: '끓여서 식혔다. 세상에서 가장 과소평가된 물건.',
    },
    water_dirty: {
      name: '탁한 물',
      description: '못에서 떠 왔다. 목숨은 붙여주고, 그러고 나서 그러지 말았기를 바라게 한다.',
    },
    watering_can: {
      name: '물뿌리개',
      description: '고철을 두들겨 만들었다. 조심히 걸으면 밭 한 자리 분량은 된다.',
    },
    wheat: {
      name: '밀',
      description: '익은 이삭 한 다발. 연마석을 거치기 전에는 먹을 수 없다.',
    },
    wire: {
      name: '철사',
      description: '인발한 구리. 덫, 함정, 그리고 전기가 통해야 하는 모든 것.',
    },
    wood_log: {
      name: '통나무',
      description: '거칠게 자른 줄기 한 토막. 나무로 된 모든 것이 여기서 시작한다.',
    },
    wood_plank: {
      name: '판자',
      description: '평평하고 각지게 켰다. 구조재이고, 통나무보다 훨씬 덜 낭비한다.',
    },
    wooden_club: {
      name: '나무 곤봉',
      description: '한쪽 끝을 좁힌 통나무. 조악하지만 어쨌든 두개골을 함몰시킨다.',
    },
    work_boots: {
      name: '작업화',
      description: '강철 발끝, 두꺼운 밑창. 발로 밟아 뭉갤 수 있다.',
    },
    work_gloves: {
      name: '작업 장갑',
      description: '손바닥을 보강했다. 돌을 나르다 살이 벗겨지지 않는다.',
    },
    workbench_kit: {
      name: '작업대 키트',
      description: '가대와 상판, 조립만 하면 된다. 만들 값이 있는 모든 것에 필요하다.',
    },
    wrench: {
      name: '렌치',
      description: '차 한 대를 쓸모 있는 뼈대까지 분해한다.',
    },
  },
  recipes: {
    bake_bread: { name: '빵' },
    bake_potato: { name: '구운 감자' },
    boil_water: { name: '물 끓이기' },
    boil_water_batch: { name: '물 끓이기 (다량)' },
    brew_tea_herbal: { name: '약초차' },
    cook_fish: { name: '구운 생선' },
    cook_meat: { name: '구운 고기' },
    cook_soup_vegetable: { name: '채소 수프' },
    cook_stew_meat: { name: '고기 스튜' },
    craft_anvil_kit: { name: '모루 키트' },
    craft_arrow_iron: { name: '철 화살' },
    craft_arrow_wooden: { name: '나무 화살' },
    craft_bandage_dirty: { name: '더러운 붕대' },
    craft_bed_kit: { name: '침대 키트' },
    craft_bolt: { name: '석궁 볼트' },
    craft_campfire_kit: { name: '모닥불 키트' },
    craft_chemistry_bench_kit: { name: '화학 작업대 키트' },
    craft_cloth_rag: { name: '천 조각' },
    craft_cooking_pot_kit: { name: '요리 냄비' },
    craft_crossbow: { name: '석궁' },
    craft_disinfected_rag: { name: '소독한 천 조각' },
    craft_farm_plot_kit: { name: '밭 키트' },
    craft_fishing_rod: { name: '낚싯대' },
    craft_furnace_kit: { name: '용광로 키트' },
    craft_grindstone_kit: { name: '연마석 키트' },
    craft_hammer: { name: '망치' },
    craft_hoe: { name: '괭이' },
    craft_hunting_bow: { name: '수렵용 활' },
    craft_iron_axe: { name: '철 도끼' },
    craft_iron_knife: { name: '철 칼' },
    craft_iron_pickaxe: { name: '철 곡괭이' },
    craft_lantern: { name: '등불' },
    craft_lockpick: { name: '자물쇠 따개' },
    craft_loom_kit: { name: '직조기 키트' },
    craft_nail: { name: '못' },
    craft_nail_bat: { name: '못 박은 방망이' },
    craft_pitchfork: { name: '쇠스랑' },
    craft_rag_from_cloth: { name: '천을 찢어 조각내기' },
    craft_rope: { name: '밧줄' },
    craft_saw: { name: '톱' },
    craft_shovel: { name: '삽' },
    craft_sickle: { name: '낫' },
    craft_sledgehammer: { name: '대형 망치' },
    craft_spear: { name: '창' },
    craft_splint_medical: { name: '의료용 부목' },
    craft_splint_wood: { name: '나무 부목' },
    craft_stick: { name: '나뭇가지' },
    craft_stone_block: { name: '석재' },
    craft_stone_hatchet: { name: '돌 손도끼' },
    craft_stone_knife: { name: '돌 칼' },
    craft_stone_pickaxe: { name: '돌 곡괭이' },
    craft_storage_box_kit: { name: '보관함 키트' },
    craft_suture_kit: { name: '봉합 키트' },
    craft_throwing_rock: { name: '던질 돌' },
    craft_torch: { name: '횃불' },
    craft_water_barrel_kit: { name: '물통 키트' },
    craft_watering_can: { name: '물뿌리개' },
    craft_wire: { name: '철사' },
    craft_wood_plank: { name: '판자' },
    craft_wooden_club: { name: '나무 곤봉' },
    craft_workbench_kit: { name: '작업대 키트' },
    craft_wrench: { name: '렌치' },
    distill_moonshine: { name: '밀주 (과일)' },
    distill_moonshine_corn: { name: '밀주 (옥수수)' },
    fire_clay_brick: { name: '점토 벽돌' },
    forge_ammo_308: { name: '.308 탄약' },
    forge_ammo_9mm: { name: '9mm 탄약' },
    forge_ammo_casing: { name: '탄피' },
    forge_ammo_shell: { name: '산탄 탄약' },
    forge_crowbar: { name: '쇠지레' },
    forge_iron_sword: { name: '철검' },
    forge_machete: { name: '마체테' },
    forge_steel_axe: { name: '강철 도끼' },
    forge_steel_pickaxe: { name: '강철 곡괭이' },
    make_antibiotics: { name: '항생제' },
    make_antiseptic: { name: '소독약' },
    make_bandage_clean: { name: '깨끗한 붕대' },
    make_bandage_sterile: { name: '멸균 드레싱' },
    make_compost: { name: '퇴비' },
    make_dough: { name: '반죽' },
    make_fertilizer: { name: '비료' },
    make_first_aid_kit: { name: '구급상자' },
    make_gunpowder: { name: '화약' },
    make_jerky: { name: '육포' },
    make_molotov: { name: '화염병' },
    make_painkiller: { name: '진통제' },
    mill_bone_meal: { name: '골분' },
    mill_flour: { name: '밀가루' },
    sew_backpack_large: { name: '큰 배낭' },
    sew_backpack_small: { name: '작은 배낭' },
    sew_cloth_pants: { name: '천 바지' },
    sew_cloth_shirt: { name: '천 셔츠' },
    sew_leather_cap: { name: '가죽 모자' },
    sew_leather_gloves: { name: '가죽 장갑' },
    sew_leather_jacket: { name: '가죽 재킷' },
    sew_leather_pants: { name: '가죽 바지' },
    sew_tool_belt: { name: '공구 벨트' },
    smelt_charcoal: { name: '숯' },
    smelt_copper_ingot: { name: '구리 주괴' },
    smelt_glass: { name: '판유리' },
    smelt_glass_from_shards: { name: '유리 재주조' },
    smelt_iron_ingot: { name: '철 주괴' },
    smelt_scrap_to_iron: { name: '고철 재제련' },
    smelt_steel_ingot: { name: '강철 주괴' },
    tan_leather: { name: '가죽 무두질' },
    weave_cloth_fiber: { name: '천 (섬유로)' },
    weave_cloth_rags: { name: '천 (조각으로)' },
  },
  structures: {
    anvil: {
      name: '모루',
      description: '그루터기에 얹은 철판. 도구를 얽어 묶는 대신 벼려 만들기 시작하는 곳.',
    },
    barricade_wood: {
      name: '나무 바리케이드',
      description: '입구에 판자를 못질해 막은 것. 빠르고, 보기 흉하고, 하룻밤을 벌어준다.',
    },
    bear_trap: {
      name: '곰 덫',
      description: '튀어 오르는 강철 턱. 무언가 하나를 오래 붙잡아 둔다.',
    },
    bed_bedroll: {
      name: '침낭',
      description: '섬유 깔개 위에 천을 덮은 것. 온몸이 쑤시겠지만, 어쨌든 깨어난다.',
    },
    bed_wood: {
      name: '나무 침대',
      description: '골조와 살대, 그리고 진짜 매트리스. 밤을 제대로 넘길 수 있다.',
    },
    campfire: {
      name: '모닥불',
      description: '빛, 열, 익힌 음식, 깨끗한 물. 네 가지를 이만큼 해내는 것은 없다.',
    },
    chemistry_bench: {
      name: '화학 작업대',
      description: '증류기와 버너, 그리고 꼼꼼한 기록. 약, 화약, 술을 만든다.',
    },
    compost_bin: {
      name: '퇴비통',
      description: '찌꺼기와 부패물을 담는 살대 상자. 먹을 수 없는 수확을 여기에 넣는다.',
    },
    cooking_pot: {
      name: '요리 냄비',
      description: '삼각대에 걸린 철 냄비. 수프와 스튜, 그리고 한 번에 물 네 병.',
    },
    door_metal: {
      name: '금속 문',
      description: '강철 틀에 끼운 강철 판, 자물쇠까지. 더 이상 문을 지을 필요가 없다.',
    },
    door_reinforced: {
      name: '보강 문',
      description: '판자 위에 고철판을 볼트로 박고, 안에서 걸 수 있는 빗장까지.',
    },
    door_wood: {
      name: '나무 문',
      description: '밧줄 경첩에 매달린 판자 문. 닫히기는 하니 절반은 한 셈이다.',
    },
    farm_plot: {
      name: '밭',
      description: '테를 두르고 파서 고른 땅. 한 번에 한 작물, 물을 줘야 한다.',
    },
    fence_barbed: {
      name: '철조망',
      description: '말뚝 사이에 철사를 걸었다. 걸어 들어와서는 계속 걸어 들어온다.',
    },
    fence_wood: {
      name: '나무 울타리',
      description: '허리 높이 말뚝. 보행자를 늦추고 토끼를 막는다.',
    },
    floor_stone: {
      name: '석재 바닥',
      description: '판석. 발소리가 없다는 게 들리는 것보다 중요하다.',
    },
    floor_wood: {
      name: '나무 바닥',
      description: '골조 위에 깐 판자. 진흙은 막고 소리는 키운다.',
    },
    foundation_stone: {
      name: '석재 기초',
      description: '점토에 앉힌 다듬은 석재. 느리고 무겁지만 썩지 않는다.',
    },
    foundation_wood: {
      name: '나무 기초',
      description: '통나무를 깔아 수평을 맞춘 것. 나머지 전부가 올라앉을 자리.',
    },
    furnace: {
      name: '용광로',
      description: '돌에서 철을 뽑아낼 만큼 뜨거운 불을 석재와 점토로 감쌌다.',
    },
    gate_metal: {
      name: '금속 대문',
      description: '차량용 문을 잘라 다시 달았다. 기대도 될 만큼 무겁다.',
    },
    gate_wood: {
      name: '나무 대문',
      description: '내가 통제하는 틈. 어느 담이든 정확히 하나는 필요하다.',
    },
    grindstone: {
      name: '연마석',
      description: '크랭크에 달린 숫돌. 밀가루와 골분, 그리고 무뎌진 칼날을 되살린다.',
    },
    hatch: {
      name: '해치',
      description: '바닥에 낸 뚜껑문. 반대편에서 빗장을 건다.',
    },
    ladder: {
      name: '사다리',
      description: '기둥 둘과 발판 여덟. 계단보다 싸고, 걷어 올릴 수 있다.',
    },
    lantern_post: {
      name: '등불 기둥',
      description: '말뚝에 매단 등불. 횃불보다 밝고 사흘 밤을 간다.',
    },
    loom: {
      name: '직조기',
      description: '날실, 씨실, 바디. 풀 더미를 옷으로 바꾼다.',
    },
    planter_box: {
      name: '화단 상자',
      description: '높이고 퇴비를 섞어 물을 머금는다. 더 빨리 자라고 덜 마른다.',
    },
    sandbag: {
      name: '모래주머니 벽',
      description: '천과 모래를 쌓았다. 지을 수 있는 무엇보다 총알을 잘 먹는다.',
    },
    sign: {
      name: '표지판',
      description: '판자에 글을 태워 새겼다. 멀티플레이에서 가장 값싼 협력 수단.',
    },
    spike_trap: {
      name: '말뚝 함정',
      description: '얕은 구덩이에 불로 굳힌 말뚝. 조용하고 싸지만, 다시 놓이지는 않는다.',
    },
    stairs_stone: {
      name: '석재 계단',
      description: '깎아낸 단. 불에 타지 않는다.',
    },
    stairs_wood: {
      name: '나무 계단',
      description: '디딤판 여섯과 측판. 지붕으로 올라갈 수 있다.',
    },
    storage_box: {
      name: '보관 상자',
      description: '물건을 둘 다른 곳 스무 칸.',
    },
    storage_crate: {
      name: '보관 나무상자',
      description: '제대로 보강한 상자. 서른 칸, 현장에서 조립.',
    },
    storage_locker: {
      name: '강철 사물함',
      description: '강판과 걸쇠. 불을 견디는 마흔 칸.',
    },
    torch_wall: {
      name: '벽 횃불',
      description: '벽에 박아 넣은 횃불. 밤의 대부분을 버틴다.',
    },
    wall_metal: {
      name: '금속 벽',
      description: '용접 골조에 철판. 거구가 튕겨 나가는데, 그게 요점이다.',
    },
    wall_stone: {
      name: '석재 벽',
      description: '층층이 쌓은 석재. 품은 네 배지만 벽은 세 배.',
    },
    wall_wood: {
      name: '나무 벽',
      description: '양면에 판자를 댔다. 초반의 표준이지만 한 달을 못 버틴다.',
    },
    wall_wood_frame: {
      name: '나무 골조 벽',
      description: '나뭇가지를 얽어 만든 격자. 보행자는 막지만 그 이상은 못 막는다.',
    },
    watchtower: {
      name: '감시탑',
      description: '다리 넷과 발판. 무리가 아직 소문일 때 볼 수 있다.',
    },
    water_barrel: {
      name: '물통',
      description: '비를 받아 담는다. 매일 못까지 걸어갈 일이 없어진다.',
    },
    well: {
      name: '우물',
      description: '파고 벽을 대고 두레박을 걸었다. 이틀 삽질로 영원한 깨끗한 물.',
    },
    window_barred: {
      name: '창살 창',
      description: '개구부에 철근을 용접했다. 빛은 들어오고 팔은 나간다.',
    },
    window_wood: {
      name: '창',
      description: '틀에 끼운 유리. 오는 것이 보이고, 그들도 나를 본다.',
    },
    workbench: {
      name: '작업대',
      description: '평평한 판과 바이스. 만들 수 있는 것이 가장 크게 뛰는 지점.',
    },
  },
  nodes: {
    bush_berry: { name: '산딸기 덤불' },
    bush_thorn: { name: '가시덤불' },
    car_wreck: { name: '폐차' },
    clay_deposit: { name: '점토 지대' },
    fallen_log: { name: '쓰러진 통나무' },
    fishing_spot: { name: '낚시터' },
    herb_patch: { name: '약초 무리' },
    mushroom_patch: { name: '버섯 무리' },
    ore_coal: { name: '석탄층' },
    ore_copper: { name: '구리 광맥' },
    ore_iron: { name: '철 광맥' },
    plant_fiber_patch: { name: '섬유풀' },
    rock_boulder: { name: '큰 바위' },
    rock_small: { name: '작은 돌' },
    sand_deposit: { name: '모래 구덩이' },
    scrap_pile: { name: '고철 더미' },
    stump: { name: '나무 그루터기' },
    tree_birch: { name: '자작나무' },
    tree_dead: { name: '고사목' },
    tree_oak: { name: '참나무' },
    tree_pine: { name: '소나무' },
    water_source: { name: '물' },
  },
  zombies: {
    armored: { name: '장갑 좀비' },
    bloater: { name: '팽창체' },
    brute: { name: '거구' },
    crawler: { name: '기어다니는 것' },
    feral_dog_zombie: { name: '들개' },
    runner: { name: '질주자' },
    screamer: { name: '비명체' },
    shambler: { name: '비틀거리는 것' },
    spitter: { name: '토사체' },
    walker: { name: '보행자' },
  },
  animals: {
    bear: { name: '곰' },
    boar: { name: '멧돼지' },
    chicken: { name: '닭' },
    cow: { name: '소' },
    deer: { name: '사슴' },
    fox: { name: '여우' },
    rabbit: { name: '토끼' },
    wolf: { name: '늑대' },
  },
  crops: {
    beans: { name: '콩' },
    cabbage: { name: '양배추' },
    carrot: { name: '당근' },
    corn: { name: '옥수수' },
    herb: { name: '약초' },
    onion: { name: '양파' },
    potato: { name: '감자' },
    pumpkin: { name: '호박' },
    tomato: { name: '토마토' },
    wheat: { name: '밀' },
  },
};
