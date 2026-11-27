/** A start that lost its wake (its ticket was taken over, or the machine was stopped under it) found out before it sent a power call: nothing was sent to the machine. The start looks again (it never fails its job for it). */
export class WakeReplaced extends Error {
  constructor() {
    super('The computer was taken over by another start: nothing was sent to it');
    this.name = 'WakeReplaced';
  }
}
