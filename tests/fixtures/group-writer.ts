// Child-process writer for the cross-process group journal test.
import { GroupJournal } from "../../src/group-journal.ts";

const [root, agent, countText] = process.argv.slice(2);
const store = new GroupJournal(root!);
const count = Number(countText);
for (let index = 0; index < count; index++) {
	const messageId = 1_000 + index;
	await store.recordMessage({ chatId: -100, messageId, senderId: 7, sender: "Owner", senderKind: "owner", date: 1_790_000_000 + index, text: `shared ${index}`, entities: [] }, agent!);
	await store.claim(-100, messageId, agent!);
}
