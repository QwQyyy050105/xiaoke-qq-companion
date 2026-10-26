// The installed 1.0.10 CLI documents these fields only in its stdin examples.
// Do not serialize the object as a flag or accept arbitrary CLI input here.
export const advancedChannelJoinTypes = new Set([
  'JOIN_GUILD_TYPE_QUESTION_WITH_ADMIN_AUDIT',
  'JOIN_GUILD_TYPE_MULTI_QUESTION',
  'JOIN_GUILD_TYPE_QUIZ'
]);

const plain = value => value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const exact = (value, keys) => {
  if (!plain(value) || Object.keys(value).some(key => !keys.includes(key))) throw Error('channel_join_setting_invalid_object');
};
const text = value => {
  if (typeof value !== 'string' || !value.trim() || value.length > 10000 || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) throw Error('channel_join_setting_invalid_text');
  return value;
};
const items = value => {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) throw Error('channel_join_setting_invalid_items');
  return value;
};

export function channelJoinSettingsInput(command, parameters) {
  if(command.name==='manage.join-guild'){
    if(!plain(parameters))throw Error('channel_invalid_parameters');
    if(!Object.hasOwn(parameters,'join_guild_comment')&&!Object.hasOwn(parameters,'join_guild_answers'))return null;
    exact(parameters,['guild-id','join_guild_comment','join_guild_answers']);
    if(typeof parameters['guild-id']!=='string'||!parameters['guild-id']||parameters['guild-id'].length>128||/\s/.test(parameters['guild-id']))throw Error('channel_join_invalid_guild');
    if(Object.hasOwn(parameters,'join_guild_comment')===Object.hasOwn(parameters,'join_guild_answers'))throw Error('channel_join_answer_kind');
    const body={guild_id:parameters['guild-id']};
    if(Object.hasOwn(parameters,'join_guild_comment'))body.join_guild_comment=text(parameters.join_guild_comment);
    else body.join_guild_answers=items(parameters.join_guild_answers).map(item=>{exact(item,['answer']);return {answer:text(item.answer)};});
    const stdin=JSON.stringify(body);if(Buffer.byteLength(stdin,'utf8')>128*1024)throw Error('channel_join_setting_too_large');
    return {flagParameters:{'guild-id':parameters['guild-id']},stdin};
  }
  if (command.name !== 'manage.update-join-guild-setting') return null;
  if (!plain(parameters)) throw Error('channel_invalid_parameters');
  const type = parameters['join-type'];
  if (!advancedChannelJoinTypes.has(type)) {
    if (Object.hasOwn(parameters, 'setting')) throw Error('channel_join_setting_unexpected');
    return null;
  }
  exact(parameters, ['guild-id', 'join-type', 'setting']);
  if(typeof parameters['guild-id']!=='string'||!parameters['guild-id']||parameters['guild-id'].length>128||/\s/.test(parameters['guild-id']))throw Error('channel_join_setting_invalid_guild');
  const setting = parameters.setting;
  if (!setting) throw Error('channel_join_setting_required');
  exact(setting, type === 'JOIN_GUILD_TYPE_QUIZ' ? ['join_type', 'quiz'] : ['join_type', 'question']);
  if (setting.join_type !== undefined && setting.join_type !== type) throw Error('channel_join_setting_type_mismatch');
  let content;
  if (type === 'JOIN_GUILD_TYPE_QUIZ') {
    const quiz = setting.quiz;
    exact(quiz, ['items', 'minAnswerNum', 'minCorrectAnswerNum']);
    const questions = items(quiz.items).map(item => {
      exact(item, ['question', 'answers', 'correctAnswer']);
      const question = text(item.question), answers = items(item.answers).map(text), correctAnswer = text(item.correctAnswer);
      if (answers.length < 2 || new Set(answers).size !== answers.length || !answers.includes(correctAnswer)) throw Error('channel_join_setting_invalid_quiz_answer');
      return {question, answers, correctAnswer};
    });
    const {minAnswerNum, minCorrectAnswerNum} = quiz;
    if (!Number.isSafeInteger(minAnswerNum) || !Number.isSafeInteger(minCorrectAnswerNum)
      || minAnswerNum < 1 || minAnswerNum > questions.length || minCorrectAnswerNum < 1 || minCorrectAnswerNum > minAnswerNum) throw Error('channel_join_setting_invalid_quiz_threshold');
    content = {quiz: {items: questions, minAnswerNum, minCorrectAnswerNum}};
  } else {
    exact(setting.question, ['items']);
    const automatic = type === 'JOIN_GUILD_TYPE_MULTI_QUESTION';
    content = {question: {items: items(setting.question.items).map(item => {
      exact(item, automatic ? ['question', 'answer'] : ['question']);
      const value = {question: text(item.question)};
      if (automatic) value.answer = text(item.answer);
      return value;
    })}};
  }
  const flagParameters = {'guild-id': parameters['guild-id'], 'join-type': type};
  const stdin = JSON.stringify({guild_id: parameters['guild-id'], setting: {join_type: type, ...content}});
  if (Buffer.byteLength(stdin, 'utf8') > 128 * 1024) throw Error('channel_join_setting_too_large');
  return {flagParameters, stdin};
}

export function channelJoinSettingsCommand(command) {
  if(command.name==='manage.join-guild')return {...command,stdin_parameters:{
    join_guild_comment:{type:'string',description:'Owner-supplied application comment or one-question answer; available only through the saved verification-question flow after real questions were fully delivered.'},
    join_guild_answers:{type:'array',items:{answer:'string'},description:'Owner-supplied answers in the actual returned question order. Never solve or invent answers. Use the saved verification-question flow, not a new unbound join plan.'}
  }};
  if (command.name !== 'manage.update-join-guild-setting') return command;
  return {...command, stdin_parameters: {
    setting: {
      type: 'object',
      description: 'Required for the three advanced join types. Keep guild-id and join-type as normal parameters; add setting as a real JSON object. Never invent questions, correct answers or thresholds; ask the owner for missing values. Use question, not title.',
      variants: {
        JOIN_GUILD_TYPE_QUESTION_WITH_ADMIN_AUDIT: {question: {items: [{question: 'Exact owner-supplied question'}]}},
        JOIN_GUILD_TYPE_MULTI_QUESTION: {question: {items: [{question: 'Exact owner-supplied question', answer: 'Exact owner-supplied answer'}]}},
        JOIN_GUILD_TYPE_QUIZ: {quiz: {items: [{question: 'Exact owner-supplied question', answers: ['Option A', 'Option B'], correctAnswer: 'Option B'}], minAnswerNum: 1, minCorrectAnswerNum: 1}}
      },
      limits: '1–20 questions, 2–20 unique quiz options; thresholds are integers and 1 <= minCorrectAnswerNum <= minAnswerNum <= question count. Basic join types have no setting object.'
    }
  }};
}
