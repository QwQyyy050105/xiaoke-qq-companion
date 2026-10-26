// Owner-installed JavaScript executes with the process's full local permissions.
// Only install reviewed modules. Chat messages can never load a plugin.
export default {apiVersion:1,id:'greeting-style',capabilities:['beforeGenerate'],setup(){return {beforeGenerate:async input=>({...input,text:input.text,chatSettings:{...input.chatSettings,examplePlugin:'loaded'}})};}};
