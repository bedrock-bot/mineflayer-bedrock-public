interface ControlState {
  forward: boolean;
  back: boolean;
  left: boolean;
  right: boolean;
  jump: boolean;
  sprint: boolean;
  sneak: boolean;
}

interface InputData {
  down_left: boolean;
  down_right: boolean;
  down: boolean;
  up: boolean;
  left: boolean;
  right: boolean;
  up_left: boolean;
  up_right: boolean;
  sprint_down: boolean;
  sprinting: boolean;
  start_sprinting: boolean;
  stop_sprinting: boolean;
}

export class InputDataService {
  #data: InputData = {
    down_left: false,
    down_right: false,
    down: false,
    up: false,
    left: false,
    right: false,
    up_left: false,
    up_right: false,
    sprint_down: false,
    sprinting: false,
    start_sprinting: false,
    stop_sprinting: false,
  };

  #prevControlState: ControlState = {
    forward: false,
    back: false,
    left: false,
    right: false,
    jump: false,
    sprint: false,
    sneak: false,
  };

  update(controlState: ControlState) {
    const prevData = { ...this.#data };

    this.#data.up = controlState.forward;
    this.#data.down = controlState.back;
    this.#data.right = controlState.right;
    this.#data.left = controlState.left;
    this.#data.up_right = controlState.forward && controlState.right;
    this.#data.up_left = controlState.forward && controlState.left;

    if (this.#prevControlState.sprint !== controlState.sprint) {
      this.#data.sprint_down = controlState.sprint;
      this.#data.sprinting = controlState.sprint;
    }

    this.#data.start_sprinting = !this.#isMoving(this.#prevControlState) && this.#isMoving(controlState);
    this.#data.stop_sprinting = this.#isMoving(this.#prevControlState) && !this.#isMoving(controlState);

    this.#prevControlState = { ...controlState };
    return {
      diff: this.#diff(this.#data, prevData),
    };
  }

  #isMoving(controlState: ControlState) {
    return (controlState.forward && !controlState.back) || (controlState.back && !controlState.forward) || (controlState.left && !controlState.right) || (controlState.right && !controlState.left);
  }

  #diff(obj1: Record<string, any>, obj2: Record<string, any>): Record<string, any> {
    var result: Record<string, any> = {};
    var change;
    for (var key in obj1) {
      if (typeof obj2[key] == 'object' && typeof obj1[key] == 'object') {
        change = this.#diff(obj1[key], obj2[key]);
        if (this.#isEmptyObject(change) === false) {
          result[key] = change;
        }
      } else if (obj2[key] != obj1[key]) {
        result[key] = obj1[key] ?? obj2[key];
      }
    }
    return result;
  }

  #isEmptyObject(obj: Record<string, any>) {
    var name;
    for (name in obj) {
      return false;
    }
    return true;
  }
}
