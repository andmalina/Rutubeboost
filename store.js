import fs from "fs";
import path from "path";

const EMPTY = {
  users: [],
  sessions: [],
  videos: [],
  completions: [],
  chat: [],
  activity: [],
};

export function createStore(file) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });

  let data = EMPTY;
  if (fs.existsSync(file)) {
    try {
      data = { ...EMPTY, ...JSON.parse(fs.readFileSync(file, "utf8")) };
    } catch {
      data = { ...EMPTY };
    }
  }

  const save = () => {
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, file);
  };

  if (!fs.existsSync(file)) save();

  return {
    data,
    save,
    mutate(fn) {
      const result = fn(data);
      save();
      return result;
    },
  };
}
