let wasm;
export function __wbg_set_wasm(val) {
    wasm = val;
}


const lTextDecoder = typeof TextDecoder === 'undefined' ? (0, module.require)('util').TextDecoder : TextDecoder;

let cachedTextDecoder = new lTextDecoder('utf-8', { ignoreBOM: true, fatal: true });

cachedTextDecoder.decode();

let cachedUint8ArrayMemory0 = null;

function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function getStringFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

function addToExternrefTable0(obj) {
    const idx = wasm.__externref_table_alloc();
    wasm.__wbindgen_export_2.set(idx, obj);
    return idx;
}

function handleError(f, args) {
    try {
        return f.apply(this, args);
    } catch (e) {
        const idx = addToExternrefTable0(e);
        wasm.__wbindgen_exn_store(idx);
    }
}

let WASM_VECTOR_LEN = 0;

const lTextEncoder = typeof TextEncoder === 'undefined' ? (0, module.require)('util').TextEncoder : TextEncoder;

let cachedTextEncoder = new lTextEncoder('utf-8');

const encodeString = (typeof cachedTextEncoder.encodeInto === 'function'
    ? function (arg, view) {
    return cachedTextEncoder.encodeInto(arg, view);
}
    : function (arg, view) {
    const buf = cachedTextEncoder.encode(arg);
    view.set(buf);
    return {
        read: arg.length,
        written: buf.length
    };
});

function passStringToWasm0(arg, malloc, realloc) {

    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }

    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = encodeString(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

let cachedDataViewMemory0 = null;

function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
}

function isLikeNone(x) {
    return x === undefined || x === null;
}

function debugString(val) {
    // primitive types
    const type = typeof val;
    if (type == 'number' || type == 'boolean' || val == null) {
        return  `${val}`;
    }
    if (type == 'string') {
        return `"${val}"`;
    }
    if (type == 'symbol') {
        const description = val.description;
        if (description == null) {
            return 'Symbol';
        } else {
            return `Symbol(${description})`;
        }
    }
    if (type == 'function') {
        const name = val.name;
        if (typeof name == 'string' && name.length > 0) {
            return `Function(${name})`;
        } else {
            return 'Function';
        }
    }
    // objects
    if (Array.isArray(val)) {
        const length = val.length;
        let debug = '[';
        if (length > 0) {
            debug += debugString(val[0]);
        }
        for(let i = 1; i < length; i++) {
            debug += ', ' + debugString(val[i]);
        }
        debug += ']';
        return debug;
    }
    // Test for built-in
    const builtInMatches = /\[object ([^\]]+)\]/.exec(toString.call(val));
    let className;
    if (builtInMatches && builtInMatches.length > 1) {
        className = builtInMatches[1];
    } else {
        // Failed to match the standard '[object ClassName]'
        return toString.call(val);
    }
    if (className == 'Object') {
        // we're a user defined class or Object
        // JSON.stringify avoids problems with cycles, and is generally much
        // easier than looping through ownProperties of `val`.
        try {
            return 'Object(' + JSON.stringify(val) + ')';
        } catch (_) {
            return 'Object';
        }
    }
    // errors
    if (val instanceof Error) {
        return `${val.name}: ${val.message}\n${val.stack}`;
    }
    // TODO we could test for more things here, like `Set`s and `Map`s.
    return className;
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

function _assertClass(instance, klass) {
    if (!(instance instanceof klass)) {
        throw new Error(`expected instance of ${klass.name}`);
    }
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_export_2.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}

function passArrayJsValueToWasm0(array, malloc) {
    const ptr = malloc(array.length * 4, 4) >>> 0;
    for (let i = 0; i < array.length; i++) {
        const add = addToExternrefTable0(array[i]);
        getDataViewMemory0().setUint32(ptr + 4 * i, add, true);
    }
    WASM_VECTOR_LEN = array.length;
    return ptr;
}

let cachedUint32ArrayMemory0 = null;

function getUint32ArrayMemory0() {
    if (cachedUint32ArrayMemory0 === null || cachedUint32ArrayMemory0.byteLength === 0) {
        cachedUint32ArrayMemory0 = new Uint32Array(wasm.memory.buffer);
    }
    return cachedUint32ArrayMemory0;
}

function passArray32ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 4, 4) >>> 0;
    getUint32ArrayMemory0().set(arg, ptr / 4);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function getArrayJsValueFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    const mem = getDataViewMemory0();
    const result = [];
    for (let i = ptr; i < ptr + 4 * len; i += 4) {
        result.push(wasm.__wbindgen_export_2.get(mem.getUint32(i, true)));
    }
    wasm.__externref_drop_slice(ptr, len);
    return result;
}
/**
 * Validate raw key package bytes without constructing a KeyPackage object.
 *
 * Performs full validation: TLS deserialization, signature verification,
 * protocol version check, lifetime check, init_key ≠ encryption_key.
 *
 * # Arguments
 * * `bytes` - TLS-serialized KeyPackage bytes (from server API)
 *
 * # Returns
 * `true` if the KeyPackage is valid, `false` otherwise.
 *
 * # Example
 * ```javascript
 * const isValid = validate_key_package_bytes(kpBytes);
 * if (!isValid) console.warn("Invalid KeyPackage!");
 * ```
 * @param {Uint8Array} bytes
 * @returns {boolean}
 */
export function validate_key_package_bytes(bytes) {
    const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.validate_key_package_bytes(ptr0, len0);
    return ret !== 0;
}

/**
 * Initialize the WASM module
 *
 * Call this once at startup to set up panic hooks for better error messages.
 */
export function init() {
    wasm.init();
}

/**
 * Test function to verify the module is working
 */
export function greet() {
    wasm.greet();
}

/**
 * Type of processed message
 * @enum {0 | 1 | 2}
 */
export const MessageType = Object.freeze({
    /**
     * Application message (encrypted user content)
     */
    ApplicationMessage: 0, "0": "ApplicationMessage",
    /**
     * Proposal message (add/remove/update)
     */
    Proposal: 1, "1": "Proposal",
    /**
     * Commit message (finalizing proposals)
     */
    Commit: 2, "2": "Commit",
});
/**
 * Error codes for MLS operations
 * @enum {0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10}
 */
export const MlsErrorCode = Object.freeze({
    /**
     * Error during serialization
     */
    SerializationError: 0, "0": "SerializationError",
    /**
     * Error during deserialization
     */
    DeserializationError: 1, "1": "DeserializationError",
    /**
     * Group is not in operational state
     */
    GroupNotOperational: 2, "2": "GroupNotOperational",
    /**
     * Member not found in group
     */
    MemberNotFound: 3, "3": "MemberNotFound",
    /**
     * Invalid message format or content
     */
    InvalidMessage: 4, "4": "InvalidMessage",
    /**
     * Welcome message was expected but not generated
     */
    NoWelcome: 5, "5": "NoWelcome",
    /**
     * Invalid CID format
     */
    InvalidCid: 6, "6": "InvalidCid",
    /**
     * Storage operation failed
     */
    StorageError: 7, "7": "StorageError",
    /**
     * Crypto operation failed
     */
    CryptoError: 8, "8": "CryptoError",
    /**
     * Invalid state
     */
    InvalidState: 9, "9": "InvalidState",
    /**
     * External commit failed
     */
    ExternalCommitError: 10, "10": "ExternalCommitError",
});

const AddMessagesFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_addmessages_free(ptr >>> 0, 1));
/**
 * Messages generated when adding a member (legacy format)
 */
export class AddMessages {

    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(AddMessages.prototype);
        obj.__wbg_ptr = ptr;
        AddMessagesFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        AddMessagesFinalization.unregister(this);
        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_addmessages_free(ptr, 0);
    }
    /**
     * @returns {Uint8Array}
     */
    get proposal() {
        const ret = wasm.addmessages_proposal(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {Uint8Array}
     */
    get commit() {
        const ret = wasm.addmessages_commit(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {Uint8Array}
     */
    get welcome() {
        const ret = wasm.addmessages_welcome(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {Uint8Array | undefined}
     */
    get group_info() {
        const ret = wasm.addmessages_group_info(this.__wbg_ptr);
        let v1;
        if (ret[0] !== 0) {
            v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
            wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        }
        return v1;
    }
}

const CommitBundleFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_commitbundle_free(ptr >>> 0, 1));
/**
 * Bundle containing commit message and optional welcome
 */
export class CommitBundle {

    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(CommitBundle.prototype);
        obj.__wbg_ptr = ptr;
        CommitBundleFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        CommitBundleFinalization.unregister(this);
        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_commitbundle_free(ptr, 0);
    }
    /**
     * Get the commit message bytes
     * @returns {Uint8Array}
     */
    get commit() {
        const ret = wasm.commitbundle_commit(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * Get the welcome message bytes (if any new members were added)
     * @returns {Uint8Array | undefined}
     */
    get welcome() {
        const ret = wasm.commitbundle_welcome(this.__wbg_ptr);
        let v1;
        if (ret[0] !== 0) {
            v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
            wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        }
        return v1;
    }
    /**
     * Get the group info bytes
     * @returns {Uint8Array | undefined}
     */
    get group_info() {
        const ret = wasm.commitbundle_group_info(this.__wbg_ptr);
        let v1;
        if (ret[0] !== 0) {
            v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
            wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        }
        return v1;
    }
    /**
     * Check if this commit includes a welcome (new members added)
     * @returns {boolean}
     */
    has_welcome() {
        const ret = wasm.commitbundle_has_welcome(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Get commit as Uint8Array
     * @returns {Uint8Array}
     */
    commit_as_uint8array() {
        const ret = wasm.commitbundle_commit_as_uint8array(this.__wbg_ptr);
        return ret;
    }
    /**
     * Get welcome as Uint8Array (returns empty if no welcome)
     * @returns {Uint8Array}
     */
    welcome_as_uint8array() {
        const ret = wasm.commitbundle_welcome_as_uint8array(this.__wbg_ptr);
        return ret;
    }
}

const ExternalJoinResultFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_externaljoinresult_free(ptr >>> 0, 1));
/**
 * Result of an external join (self-join with GroupInfo)
 */
export class ExternalJoinResult {

    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(ExternalJoinResult.prototype);
        obj.__wbg_ptr = ptr;
        ExternalJoinResultFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ExternalJoinResultFinalization.unregister(this);
        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_externaljoinresult_free(ptr, 0);
    }
    /**
     * Get the joined group
     * @returns {Group | undefined}
     */
    get group() {
        const ret = wasm.externaljoinresult_group(this.__wbg_ptr);
        return ret === 0 ? undefined : Group.__wrap(ret);
    }
    /**
     * Get the commit message to broadcast
     * @returns {Uint8Array}
     */
    get commit() {
        const ret = wasm.externaljoinresult_commit(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}

const GroupFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_group_free(ptr >>> 0, 1));
/**
 * An MLS Group representing an encrypted channel
 */
export class Group {

    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(Group.prototype);
        obj.__wbg_ptr = ptr;
        GroupFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        GroupFinalization.unregister(this);
        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_group_free(ptr, 0);
    }
    /**
     * Commit all pending proposals
     *
     * This creates a commit message that includes all queued proposals.
     * Use `merge_pending_commit` after the DS confirms the commit.
     * @param {Provider} provider
     * @param {Identity} sender
     * @returns {CommitBundle}
     */
    commit_pending_proposals(provider, sender) {
        _assertClass(provider, Provider);
        _assertClass(sender, Identity);
        const ret = wasm.group_commit_pending_proposals(this.__wbg_ptr, provider.__wbg_ptr, sender.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CommitBundle.__wrap(ret[0]);
    }
    /**
     * Merge the pending commit after DS confirmation
     * @param {Provider} provider
     */
    merge_pending_commit(provider) {
        _assertClass(provider, Provider);
        const ret = wasm.group_merge_pending_commit(this.__wbg_ptr, provider.__wbg_ptr);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Discard the pending commit (rollback)
     * @param {Provider} provider
     */
    clear_pending_commit(provider) {
        _assertClass(provider, Provider);
        const ret = wasm.group_clear_pending_commit(this.__wbg_ptr, provider.__wbg_ptr);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Add members and commit immediately (convenience method)
     *
     * Use this when you want to add members without batching.
     * For batch operations, use `propose_add_member` + `commit_pending_proposals`.
     * @param {Provider} provider
     * @param {Identity} sender
     * @param {KeyPackage[]} new_members
     * @returns {CommitBundle}
     */
    add_members(provider, sender, new_members) {
        _assertClass(provider, Provider);
        _assertClass(sender, Identity);
        const ptr0 = passArrayJsValueToWasm0(new_members, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.group_add_members(this.__wbg_ptr, provider.__wbg_ptr, sender.__wbg_ptr, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CommitBundle.__wrap(ret[0]);
    }
    /**
     * Add a user with multiple devices and commit immediately
     *
     * Each KeyPackage represents one device of the same user.
     * All devices are added in a single commit.
     * @param {Provider} provider
     * @param {Identity} sender
     * @param {KeyPackage[]} device_key_packages
     * @returns {CommitBundle}
     */
    add_user(provider, sender, device_key_packages) {
        _assertClass(provider, Provider);
        _assertClass(sender, Identity);
        const ptr0 = passArrayJsValueToWasm0(device_key_packages, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.group_add_user(this.__wbg_ptr, provider.__wbg_ptr, sender.__wbg_ptr, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CommitBundle.__wrap(ret[0]);
    }
    /**
     * Remove members and commit immediately (convenience method)
     * @param {Provider} provider
     * @param {Identity} sender
     * @param {Uint32Array} member_indices
     * @returns {CommitBundle}
     */
    remove_members(provider, sender, member_indices) {
        _assertClass(provider, Provider);
        _assertClass(sender, Identity);
        const ptr0 = passArray32ToWasm0(member_indices, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.group_remove_members(this.__wbg_ptr, provider.__wbg_ptr, sender.__wbg_ptr, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CommitBundle.__wrap(ret[0]);
    }
    /**
     * Remove ALL devices of a user by user_id and commit immediately
     *
     * A user with N devices will have N leaf nodes in the group.
     * This method finds all of them and removes them in a single commit.
     * @param {Provider} provider
     * @param {Identity} sender
     * @param {string} user_id
     * @returns {CommitBundle}
     */
    remove_user(provider, sender, user_id) {
        _assertClass(provider, Provider);
        _assertClass(sender, Identity);
        const ptr0 = passStringToWasm0(user_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.group_remove_user(this.__wbg_ptr, provider.__wbg_ptr, sender.__wbg_ptr, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CommitBundle.__wrap(ret[0]);
    }
    /**
     * Key rotation with immediate commit (convenience method)
     * @param {Provider} provider
     * @param {Identity} sender
     * @returns {CommitBundle}
     */
    self_update(provider, sender) {
        _assertClass(provider, Provider);
        _assertClass(sender, Identity);
        const ret = wasm.group_self_update(this.__wbg_ptr, provider.__wbg_ptr, sender.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CommitBundle.__wrap(ret[0]);
    }
    /**
     * Combined propose and commit for adding a single member
     * This is kept for backwards compatibility with demo code
     * @param {Provider} provider
     * @param {Identity} sender
     * @param {KeyPackage} new_member
     * @returns {AddMessages}
     */
    propose_and_commit_add(provider, sender, new_member) {
        _assertClass(provider, Provider);
        _assertClass(sender, Identity);
        _assertClass(new_member, KeyPackage);
        const ret = wasm.group_propose_and_commit_add(this.__wbg_ptr, provider.__wbg_ptr, sender.__wbg_ptr, new_member.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return AddMessages.__wrap(ret[0]);
    }
    /**
     * Create an encrypted message
     *
     * # Arguments
     * * `provider` - Crypto provider
     * * `sender` - Identity of the sender
     * * `plaintext` - The message content to encrypt
     * 1
     * # Returns
     * Serialized encrypted MLS message
     * @param {Provider} provider
     * @param {Identity} sender
     * @param {Uint8Array} plaintext
     * @returns {Uint8Array}
     */
    create_message(provider, sender, plaintext) {
        _assertClass(provider, Provider);
        _assertClass(sender, Identity);
        const ptr0 = passArray8ToWasm0(plaintext, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.group_create_message(this.__wbg_ptr, provider.__wbg_ptr, sender.__wbg_ptr, ptr0, len0);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v2;
    }
    /**
     * Set Additional Authenticated Data (AAD) for the next outgoing message
     *
     * AAD is authenticated but NOT encrypted - use for metadata that needs
     * to be bound cryptographically to the ciphertext (e.g., sender_id, channel_id).
     * AAD is automatically reset after create_message() is called.
     *
     * # Arguments
     * * `aad` - Bytes to use as AAD (typically JSON-serialized metadata)
     * @param {Uint8Array} aad
     */
    set_aad(aad) {
        const ptr0 = passArray8ToWasm0(aad, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.group_set_aad(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * Create an encrypted message with AAD in one call
     *
     * This is a convenience method that sets AAD and creates the message.
     *
     * # Arguments
     * * `provider` - Crypto provider
     * * `sender` - Identity of the sender
     * * `plaintext` - The message content to encrypt
     * * `aad` - Additional authenticated data (metadata to bind to ciphertext)
     * @param {Provider} provider
     * @param {Identity} sender
     * @param {Uint8Array} plaintext
     * @param {Uint8Array} aad
     * @returns {Uint8Array}
     */
    create_message_with_aad(provider, sender, plaintext, aad) {
        _assertClass(provider, Provider);
        _assertClass(sender, Identity);
        const ptr0 = passArray8ToWasm0(plaintext, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray8ToWasm0(aad, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.group_create_message_with_aad(this.__wbg_ptr, provider.__wbg_ptr, sender.__wbg_ptr, ptr0, len0, ptr1, len1);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v3 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v3;
    }
    /**
     * Process an incoming message (decrypt or handle proposal/commit)
     *
     * This method handles all MLS message types:
     * - ApplicationMessage: Returns decrypted content
     * - Proposal: Stores as pending proposal, returns empty content
     * - Commit: Merges the staged commit, returns empty content
     * @param {Provider} provider
     * @param {Uint8Array} msg
     * @returns {ProcessedMessage}
     */
    process_message(provider, msg) {
        _assertClass(provider, Provider);
        const ptr0 = passArray8ToWasm0(msg, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.group_process_message(this.__wbg_ptr, provider.__wbg_ptr, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ProcessedMessage.__wrap(ret[0]);
    }
    /**
     * Process message and return raw bytes (legacy API, for backwards compatibility)
     *
     * Returns decrypted bytes for application messages, empty for proposals/commits.
     * @param {Provider} provider
     * @param {Uint8Array} msg
     * @returns {Uint8Array}
     */
    process_message_raw(provider, msg) {
        _assertClass(provider, Provider);
        const ptr0 = passArray8ToWasm0(msg, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.group_process_message_raw(this.__wbg_ptr, provider.__wbg_ptr, ptr0, len0);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v2;
    }
    /**
     * Propose adding a new member (does NOT commit immediately)
     *
     * Use this when you want to batch multiple proposals before committing.
     * Call `commit_pending_proposals` after queuing all proposals.
     * @param {Provider} provider
     * @param {Identity} sender
     * @param {KeyPackage} new_member
     * @returns {ProposalMessage}
     */
    propose_add_member(provider, sender, new_member) {
        _assertClass(provider, Provider);
        _assertClass(sender, Identity);
        _assertClass(new_member, KeyPackage);
        const ret = wasm.group_propose_add_member(this.__wbg_ptr, provider.__wbg_ptr, sender.__wbg_ptr, new_member.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ProposalMessage.__wrap(ret[0]);
    }
    /**
     * Propose adding a user with multiple devices (does NOT commit immediately)
     *
     * Each KeyPackage represents one device. Creates one add proposal
     * per device, all queued as pending proposals.
     * Call `commit_pending_proposals` to batch them into a single commit.
     * @param {Provider} provider
     * @param {Identity} sender
     * @param {KeyPackage[]} device_key_packages
     * @returns {ProposalMessage[]}
     */
    propose_add_user(provider, sender, device_key_packages) {
        _assertClass(provider, Provider);
        _assertClass(sender, Identity);
        const ptr0 = passArrayJsValueToWasm0(device_key_packages, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.group_propose_add_user(this.__wbg_ptr, provider.__wbg_ptr, sender.__wbg_ptr, ptr0, len0);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v2 = getArrayJsValueFromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v2;
    }
    /**
     * Propose removing a member by leaf index
     *
     * Use `member_by_user_id` to get the leaf index from a user_id.
     * @param {Provider} provider
     * @param {Identity} sender
     * @param {number} member_index
     * @returns {ProposalMessage}
     */
    propose_remove_member(provider, sender, member_index) {
        _assertClass(provider, Provider);
        _assertClass(sender, Identity);
        const ret = wasm.group_propose_remove_member(this.__wbg_ptr, provider.__wbg_ptr, sender.__wbg_ptr, member_index);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ProposalMessage.__wrap(ret[0]);
    }
    /**
     * Propose removing a member by user_id
     *
     * This is a convenience method that finds the member by credential
     * and proposes their removal.
     * Note: This only removes ONE leaf node. For multi-device users,
     * use `propose_remove_user` instead.
     * @param {Provider} provider
     * @param {Identity} sender
     * @param {string} user_id
     * @returns {ProposalMessage}
     */
    propose_remove_member_by_user_id(provider, sender, user_id) {
        _assertClass(provider, Provider);
        _assertClass(sender, Identity);
        const ptr0 = passStringToWasm0(user_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.group_propose_remove_member_by_user_id(this.__wbg_ptr, provider.__wbg_ptr, sender.__wbg_ptr, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ProposalMessage.__wrap(ret[0]);
    }
    /**
     * Propose removing ALL devices of a user by user_id
     *
     * A user with N devices will have N leaf nodes. This creates
     * one remove proposal per device. Call `commit_pending_proposals`
     * after this to finalize all removals in a single commit.
     * @param {Provider} provider
     * @param {Identity} sender
     * @param {string} user_id
     * @returns {ProposalMessage[]}
     */
    propose_remove_user(provider, sender, user_id) {
        _assertClass(provider, Provider);
        _assertClass(sender, Identity);
        const ptr0 = passStringToWasm0(user_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.group_propose_remove_user(this.__wbg_ptr, provider.__wbg_ptr, sender.__wbg_ptr, ptr0, len0);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v2 = getArrayJsValueFromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v2;
    }
    /**
     * Propose a self-update (key rotation for forward secrecy)
     * @param {Provider} provider
     * @param {Identity} sender
     * @returns {ProposalMessage}
     */
    propose_self_update(provider, sender) {
        _assertClass(provider, Provider);
        _assertClass(sender, Identity);
        const ret = wasm.group_propose_self_update(this.__wbg_ptr, provider.__wbg_ptr, sender.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ProposalMessage.__wrap(ret[0]);
    }
    /**
     * Get the number of pending proposals
     * @returns {number}
     */
    pending_proposals_count() {
        const ret = wasm.group_pending_proposals_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Clear all pending proposals without committing
     * @param {Provider} provider
     */
    clear_pending_proposals(provider) {
        _assertClass(provider, Provider);
        const ret = wasm.group_clear_pending_proposals(this.__wbg_ptr, provider.__wbg_ptr);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Get the CID (group_id as string)
     *
     * This returns the original cid string used to create the group,
     * matching the Ermis channel cid format (e.g., "team:channel_abc123")
     * @returns {string}
     */
    cid() {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.group_cid(this.__wbg_ptr);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * Get the raw group_id bytes
     * @returns {Uint8Array}
     */
    group_id() {
        const ret = wasm.group_group_id(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * Get current epoch number
     *
     * Epoch increases with each commit
     * @returns {bigint}
     */
    epoch() {
        const ret = wasm.group_epoch(this.__wbg_ptr);
        return BigInt.asUintN(64, ret);
    }
    /**
     * Get all members in the group
     * @returns {MemberInfo[]}
     */
    members() {
        const ret = wasm.group_members(this.__wbg_ptr);
        var v1 = getArrayJsValueFromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * Get a member by user_id (returns first match)
     * @param {string} user_id
     * @returns {MemberInfo | undefined}
     */
    member_by_user_id(user_id) {
        const ptr0 = passStringToWasm0(user_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.group_member_by_user_id(this.__wbg_ptr, ptr0, len0);
        return ret === 0 ? undefined : MemberInfo.__wrap(ret);
    }
    /**
     * Get ALL members (leaf nodes) for a given user_id
     *
     * A user with N devices will have N entries in the group.
     * Use this to find all leaf indices for a multi-device user.
     * @param {string} user_id
     * @returns {MemberInfo[]}
     */
    members_by_user_id(user_id) {
        const ptr0 = passStringToWasm0(user_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.group_members_by_user_id(this.__wbg_ptr, ptr0, len0);
        var v2 = getArrayJsValueFromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v2;
    }
    /**
     * Get the local member's leaf index
     * @returns {number}
     */
    own_leaf_index() {
        const ret = wasm.group_own_leaf_index(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Check if the group is in operational state
     *
     * Returns false if there's a pending commit or the group is inactive
     * @returns {boolean}
     */
    is_operational() {
        const ret = wasm.group_is_operational(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Check if there's a pending commit that hasn't been merged
     * @returns {boolean}
     */
    has_pending_commit() {
        const ret = wasm.group_has_pending_commit(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Export the ratchet tree for sharing with new members
     * @returns {RatchetTree}
     */
    export_ratchet_tree() {
        const ret = wasm.group_export_ratchet_tree(this.__wbg_ptr);
        return RatchetTree.__wrap(ret);
    }
    /**
     * Export group info for external commits
     *
     * # Arguments
     * * `with_ratchet_tree` - Whether to include the ratchet tree in the group info
     * @param {Provider} provider
     * @param {Identity} sender
     * @param {boolean} with_ratchet_tree
     * @returns {Uint8Array}
     */
    export_group_info(provider, sender, with_ratchet_tree) {
        _assertClass(provider, Provider);
        _assertClass(sender, Identity);
        const ret = wasm.group_export_group_info(this.__wbg_ptr, provider.__wbg_ptr, sender.__wbg_ptr, with_ratchet_tree);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * Export a secret key derived from the group state
     *
     * Useful for deriving encryption keys for media streams, etc.
     * @param {Provider} provider
     * @param {string} label
     * @param {Uint8Array} context
     * @param {number} key_length
     * @returns {Uint8Array}
     */
    export_key(provider, label, context, key_length) {
        _assertClass(provider, Provider);
        const ptr0 = passStringToWasm0(label, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray8ToWasm0(context, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.group_export_key(this.__wbg_ptr, provider.__wbg_ptr, ptr0, len0, ptr1, len1, key_length);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v3 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v3;
    }
    /**
     * Create a new group with a CID from Ermis
     *
     * # Arguments
     * * `provider` - Crypto provider
     * * `founder` - Identity of the group creator
     * * `cid` - Channel ID from Ermis (e.g., "team:channel_abc123")
     *
     * # Example
     * ```javascript
     * const group = Group.create_with_cid(provider, identity, "team:my_channel");
     * ```
     * @param {Provider} provider
     * @param {Identity} founder
     * @param {string} cid
     * @returns {Group}
     */
    static create_with_cid(provider, founder, cid) {
        _assertClass(provider, Provider);
        _assertClass(founder, Identity);
        const ptr0 = passStringToWasm0(cid, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.group_create_with_cid(provider.__wbg_ptr, founder.__wbg_ptr, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return Group.__wrap(ret[0]);
    }
    /**
     * Load a group from the Provider's storage by CID
     *
     * After restoring a Provider from bytes (IndexedDB), call this to reopen
     * a group that was previously created or joined.
     *
     * # Arguments
     * * `provider` - Crypto provider (restored from bytes)
     * * `cid` - Channel ID (e.g., "team:channel_abc123")
     * @param {Provider} provider
     * @param {string} cid
     * @returns {Group}
     */
    static load(provider, cid) {
        _assertClass(provider, Provider);
        const ptr0 = passStringToWasm0(cid, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.group_load(provider.__wbg_ptr, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return Group.__wrap(ret[0]);
    }
    /**
     * Persist the group's current state to the Provider's storage.
     *
     * MUST be called after processing application messages (decrypt) to save
     * the updated ratchet/secret tree state. Without this, a Provider restore
     * (e.g., on page reload) will load stale ratchet state, causing
     * SecretReuseError for messages that were already decrypted.
     * @param {Provider} provider
     */
    save_state(provider) {
        _assertClass(provider, Provider);
        const ret = wasm.group_save_state(this.__wbg_ptr, provider.__wbg_ptr);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Create a new group (legacy API, uses group_id string directly)
     * @param {Provider} provider
     * @param {Identity} founder
     * @param {string} group_id
     * @returns {Group}
     */
    static create_new(provider, founder, group_id) {
        _assertClass(provider, Provider);
        _assertClass(founder, Identity);
        const ptr0 = passStringToWasm0(group_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.group_create_new(provider.__wbg_ptr, founder.__wbg_ptr, ptr0, len0);
        return Group.__wrap(ret);
    }
    /**
     * Join a group using a Welcome message
     *
     * # Arguments
     * * `provider` - Crypto provider
     * * `welcome` - Serialized Welcome message bytes
     * * `ratchet_tree` - Optional ratchet tree (if not embedded in welcome)
     * @param {Provider} provider
     * @param {Uint8Array} welcome
     * @param {RatchetTree | null} [ratchet_tree]
     * @returns {Group}
     */
    static join_with_welcome(provider, welcome, ratchet_tree) {
        _assertClass(provider, Provider);
        const ptr0 = passArray8ToWasm0(welcome, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        let ptr1 = 0;
        if (!isLikeNone(ratchet_tree)) {
            _assertClass(ratchet_tree, RatchetTree);
            ptr1 = ratchet_tree.__destroy_into_raw();
        }
        const ret = wasm.group_join_with_welcome(provider.__wbg_ptr, ptr0, len0, ptr1);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return Group.__wrap(ret[0]);
    }
    /**
     * Join a group using a Welcome (legacy API)
     * @param {Provider} provider
     * @param {Uint8Array} welcome
     * @param {RatchetTree} ratchet_tree
     * @returns {Group}
     */
    static join(provider, welcome, ratchet_tree) {
        _assertClass(provider, Provider);
        const ptr0 = passArray8ToWasm0(welcome, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        _assertClass(ratchet_tree, RatchetTree);
        var ptr1 = ratchet_tree.__destroy_into_raw();
        const ret = wasm.group_join(provider.__wbg_ptr, ptr0, len0, ptr1);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return Group.__wrap(ret[0]);
    }
    /**
     * Join a group via External Commit
     *
     * This allows a user to join a group without needing a Welcome message,
     * using only the GroupInfo.
     *
     * # Arguments
     * * `provider` - Crypto provider
     * * `identity` - Identity of the joiner
     * * `group_info` - Serialized GroupInfo bytes
     * * `ratchet_tree` - Optional ratchet tree
     *
     * # Returns
     * ExternalJoinResult containing the joined group and commit message to broadcast
     * @param {Provider} provider
     * @param {Identity} identity
     * @param {Uint8Array} group_info
     * @param {RatchetTree | null} [ratchet_tree]
     * @returns {ExternalJoinResult}
     */
    static join_external(provider, identity, group_info, ratchet_tree) {
        _assertClass(provider, Provider);
        _assertClass(identity, Identity);
        const ptr0 = passArray8ToWasm0(group_info, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        let ptr1 = 0;
        if (!isLikeNone(ratchet_tree)) {
            _assertClass(ratchet_tree, RatchetTree);
            ptr1 = ratchet_tree.__destroy_into_raw();
        }
        const ret = wasm.group_join_external(provider.__wbg_ptr, identity.__wbg_ptr, ptr0, len0, ptr1);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ExternalJoinResult.__wrap(ret[0]);
    }
}

const IdentityFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_identity_free(ptr >>> 0, 1));
/**
 * Represents a user's MLS identity with credentials and signing keys
 */
export class Identity {

    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(Identity.prototype);
        obj.__wbg_ptr = ptr;
        IdentityFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        IdentityFinalization.unregister(this);
        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_identity_free(ptr, 0);
    }
    /**
     * Create a new identity for a user
     *
     * # Arguments
     * * `provider` - The crypto provider
     * * `user_id` - Unique identifier for the user (e.g., from Ermis user system)
     * @param {Provider} provider
     * @param {string} user_id
     */
    constructor(provider, user_id) {
        _assertClass(provider, Provider);
        const ptr0 = passStringToWasm0(user_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.identity_new(provider.__wbg_ptr, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        this.__wbg_ptr = ret[0] >>> 0;
        IdentityFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Get the user_id from this identity
     * @returns {string}
     */
    get user_id() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.identity_user_id(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Generate a single key package for this identity
     * @param {Provider} provider
     * @returns {KeyPackage}
     */
    key_package(provider) {
        _assertClass(provider, Provider);
        const ret = wasm.identity_key_package(this.__wbg_ptr, provider.__wbg_ptr);
        return KeyPackage.__wrap(ret);
    }
    /**
     * Generate multiple key packages for multi-device support
     *
     * # Arguments
     * * `provider` - The crypto provider
     * * `count` - Number of key packages to generate
     * @param {Provider} provider
     * @param {number} count
     * @returns {KeyPackage[]}
     */
    key_packages(provider, count) {
        _assertClass(provider, Provider);
        const ret = wasm.identity_key_packages(this.__wbg_ptr, provider.__wbg_ptr, count);
        var v1 = getArrayJsValueFromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * Serialize identity for storage
     * Note: This only exports the keypair, credential will be reconstructed
     * @returns {Uint8Array}
     */
    to_bytes() {
        const ret = wasm.identity_to_bytes(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * Restore identity from bytes
     * @param {Provider} provider
     * @param {Uint8Array} bytes
     * @returns {Identity}
     */
    static from_bytes(provider, bytes) {
        _assertClass(provider, Provider);
        const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.identity_from_bytes(provider.__wbg_ptr, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return Identity.__wrap(ret[0]);
    }
}

const KeyPackageFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_keypackage_free(ptr >>> 0, 1));
/**
 * A KeyPackage for joining groups
 */
export class KeyPackage {

    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(KeyPackage.prototype);
        obj.__wbg_ptr = ptr;
        KeyPackageFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }

    static __unwrap(jsValue) {
        if (!(jsValue instanceof KeyPackage)) {
            return 0;
        }
        return jsValue.__destroy_into_raw();
    }

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        KeyPackageFinalization.unregister(this);
        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_keypackage_free(ptr, 0);
    }
    /**
     * Serialize this KeyPackage to bytes
     * @returns {Uint8Array}
     */
    to_bytes() {
        const ret = wasm.keypackage_to_bytes(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * Deserialize a KeyPackage from bytes
     * @param {Uint8Array} bytes
     * @returns {KeyPackage}
     */
    static from_bytes(bytes) {
        const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.keypackage_from_bytes(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return KeyPackage.__wrap(ret[0]);
    }
    /**
     * Get the hash reference of this key package
     * @param {Provider} provider
     * @returns {Uint8Array}
     */
    hash_ref(provider) {
        _assertClass(provider, Provider);
        const ret = wasm.keypackage_hash_ref(this.__wbg_ptr, provider.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}

const MemberInfoFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_memberinfo_free(ptr >>> 0, 1));
/**
 * Information about a group member
 */
export class MemberInfo {

    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(MemberInfo.prototype);
        obj.__wbg_ptr = ptr;
        MemberInfoFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        MemberInfoFinalization.unregister(this);
        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_memberinfo_free(ptr, 0);
    }
    /**
     * Get the member's leaf index
     * @returns {number}
     */
    get index() {
        const ret = wasm.memberinfo_index(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Get the member's user_id
     * @returns {string}
     */
    get user_id() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.memberinfo_user_id(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Get the member's encryption key
     * @returns {Uint8Array}
     */
    get encryption_key() {
        const ret = wasm.memberinfo_encryption_key(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * Get the member's signature key
     * @returns {Uint8Array}
     */
    get signature_key() {
        const ret = wasm.memberinfo_signature_key(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}

const MlsErrorFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_mlserror_free(ptr >>> 0, 1));
/**
 * Custom error type for MLS operations
 */
export class MlsError {

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        MlsErrorFinalization.unregister(this);
        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_mlserror_free(ptr, 0);
    }
    /**
     * Create a new MlsError
     * @param {MlsErrorCode} code
     * @param {string} message
     */
    constructor(code, message) {
        const ptr0 = passStringToWasm0(message, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.mlserror_new(code, ptr0, len0);
        this.__wbg_ptr = ret >>> 0;
        MlsErrorFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Get error code
     * @returns {MlsErrorCode}
     */
    get code() {
        const ret = wasm.mlserror_code(this.__wbg_ptr);
        return ret;
    }
    /**
     * Get error message
     * @returns {string}
     */
    get message() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.mlserror_message(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
}

const ProcessedMessageFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_processedmessage_free(ptr >>> 0, 1));
/**
 * Result of processing an incoming message
 */
export class ProcessedMessage {

    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(ProcessedMessage.prototype);
        obj.__wbg_ptr = ptr;
        ProcessedMessageFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ProcessedMessageFinalization.unregister(this);
        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_processedmessage_free(ptr, 0);
    }
    /**
     * Get the type of message
     * @returns {MessageType}
     */
    get message_type() {
        const ret = wasm.processedmessage_message_type(this.__wbg_ptr);
        return ret;
    }
    /**
     * Get the decrypted content (only for ApplicationMessage)
     * @returns {Uint8Array | undefined}
     */
    get content() {
        const ret = wasm.processedmessage_content(this.__wbg_ptr);
        let v1;
        if (ret[0] !== 0) {
            v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
            wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        }
        return v1;
    }
    /**
     * Get the sender's leaf index
     * @returns {number}
     */
    get sender_index() {
        const ret = wasm.processedmessage_sender_index(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Get the epoch this message belongs to
     * @returns {bigint}
     */
    get epoch() {
        const ret = wasm.processedmessage_epoch(this.__wbg_ptr);
        return BigInt.asUintN(64, ret);
    }
    /**
     * Get the Additional Authenticated Data (AAD) from the message
     * This is the metadata that was bound to the ciphertext during encryption
     * @returns {Uint8Array}
     */
    get aad() {
        const ret = wasm.processedmessage_aad(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * Check if this is an application message
     * @returns {boolean}
     */
    is_application_message() {
        const ret = wasm.processedmessage_is_application_message(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Check if this is a proposal
     * @returns {boolean}
     */
    is_proposal() {
        const ret = wasm.processedmessage_is_proposal(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Check if this is a commit
     * @returns {boolean}
     */
    is_commit() {
        const ret = wasm.processedmessage_is_commit(this.__wbg_ptr);
        return ret !== 0;
    }
}

const ProposalMessageFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_proposalmessage_free(ptr >>> 0, 1));
/**
 * A proposal message that can be sent to other group members
 */
export class ProposalMessage {

    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(ProposalMessage.prototype);
        obj.__wbg_ptr = ptr;
        ProposalMessageFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ProposalMessageFinalization.unregister(this);
        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_proposalmessage_free(ptr, 0);
    }
    /**
     * Get the serialized proposal message bytes
     * @returns {Uint8Array}
     */
    get bytes() {
        const ret = wasm.proposalmessage_bytes(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * Get the proposal reference for tracking
     * @returns {Uint8Array}
     */
    get proposal_ref() {
        const ret = wasm.proposalmessage_proposal_ref(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * Get bytes as Uint8Array for JavaScript
     * @returns {Uint8Array}
     */
    bytes_as_uint8array() {
        const ret = wasm.proposalmessage_bytes_as_uint8array(this.__wbg_ptr);
        return ret;
    }
}

const ProviderFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_provider_free(ptr >>> 0, 1));
/**
 * Crypto provider for MLS operations
 */
export class Provider {

    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(Provider.prototype);
        obj.__wbg_ptr = ptr;
        ProviderFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ProviderFinalization.unregister(this);
        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_provider_free(ptr, 0);
    }
    constructor() {
        const ret = wasm.provider_new();
        this.__wbg_ptr = ret >>> 0;
        ProviderFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Serialize the key store to bytes for persistence (e.g. IndexedDB)
     *
     * Returns the serialized key store as a byte array.
     * Use `Provider.from_bytes()` to restore.
     * @returns {Uint8Array}
     */
    to_bytes() {
        const ret = wasm.provider_to_bytes(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * Restore a Provider from previously serialized bytes
     *
     * The crypto provider (RNG) is always fresh; only the key store
     * (private keys, group state, etc.) is restored from bytes.
     * @param {Uint8Array} bytes
     * @returns {Provider}
     */
    static from_bytes(bytes) {
        const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.provider_from_bytes(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return Provider.__wrap(ret[0]);
    }
}

const RatchetTreeFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_ratchettree_free(ptr >>> 0, 1));
/**
 * Ratchet tree for group state synchronization
 */
export class RatchetTree {

    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(RatchetTree.prototype);
        obj.__wbg_ptr = ptr;
        RatchetTreeFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        RatchetTreeFinalization.unregister(this);
        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_ratchettree_free(ptr, 0);
    }
    /**
     * Serialize this RatchetTree to bytes
     * @returns {Uint8Array}
     */
    to_bytes() {
        const ret = wasm.ratchettree_to_bytes(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * Deserialize a RatchetTree from bytes
     * @param {Uint8Array} bytes
     * @returns {RatchetTree}
     */
    static from_bytes(bytes) {
        const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.ratchettree_from_bytes(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return RatchetTree.__wrap(ret[0]);
    }
}

export function __wbg_alert_28f254ad01ccf9c4(arg0, arg1) {
    alert(getStringFromWasm0(arg0, arg1));
};

export function __wbg_buffer_609cc3eee51ed158(arg0) {
    const ret = arg0.buffer;
    return ret;
};

export function __wbg_call_672a4d21634d4a24() { return handleError(function (arg0, arg1) {
    const ret = arg0.call(arg1);
    return ret;
}, arguments) };

export function __wbg_call_7cccdd69e0791ae2() { return handleError(function (arg0, arg1, arg2) {
    const ret = arg0.call(arg1, arg2);
    return ret;
}, arguments) };

export function __wbg_crypto_574e78ad8b13b65f(arg0) {
    const ret = arg0.crypto;
    return ret;
};

export function __wbg_error_7534b8e9a36f1ab4(arg0, arg1) {
    let deferred0_0;
    let deferred0_1;
    try {
        deferred0_0 = arg0;
        deferred0_1 = arg1;
        console.error(getStringFromWasm0(arg0, arg1));
    } finally {
        wasm.__wbindgen_free(deferred0_0, deferred0_1, 1);
    }
};

export function __wbg_getRandomValues_b8f5dbd5f3995a9e() { return handleError(function (arg0, arg1) {
    arg0.getRandomValues(arg1);
}, arguments) };

export function __wbg_keypackage_new(arg0) {
    const ret = KeyPackage.__wrap(arg0);
    return ret;
};

export function __wbg_keypackage_unwrap(arg0) {
    const ret = KeyPackage.__unwrap(arg0);
    return ret;
};

export function __wbg_memberinfo_new(arg0) {
    const ret = MemberInfo.__wrap(arg0);
    return ret;
};

export function __wbg_msCrypto_a61aeb35a24c1329(arg0) {
    const ret = arg0.msCrypto;
    return ret;
};

export function __wbg_new_8a6f238a6ece86ea() {
    const ret = new Error();
    return ret;
};

export function __wbg_new_a12002a7f91c75be(arg0) {
    const ret = new Uint8Array(arg0);
    return ret;
};

export function __wbg_newnoargs_105ed471475aaf50(arg0, arg1) {
    const ret = new Function(getStringFromWasm0(arg0, arg1));
    return ret;
};

export function __wbg_newwithbyteoffsetandlength_d97e637ebe145a9a(arg0, arg1, arg2) {
    const ret = new Uint8Array(arg0, arg1 >>> 0, arg2 >>> 0);
    return ret;
};

export function __wbg_newwithlength_a381634e90c276d4(arg0) {
    const ret = new Uint8Array(arg0 >>> 0);
    return ret;
};

export function __wbg_node_905d3e251edff8a2(arg0) {
    const ret = arg0.node;
    return ret;
};

export function __wbg_now_807e54c39636c349() {
    const ret = Date.now();
    return ret;
};

export function __wbg_process_dc0fbacc7c1c06f7(arg0) {
    const ret = arg0.process;
    return ret;
};

export function __wbg_proposalmessage_new(arg0) {
    const ret = ProposalMessage.__wrap(arg0);
    return ret;
};

export function __wbg_randomFillSync_ac0988aba3254290() { return handleError(function (arg0, arg1) {
    arg0.randomFillSync(arg1);
}, arguments) };

export function __wbg_require_60cc747a6bc5215a() { return handleError(function () {
    const ret = module.require;
    return ret;
}, arguments) };

export function __wbg_set_65595bdd868b3009(arg0, arg1, arg2) {
    arg0.set(arg1, arg2 >>> 0);
};

export function __wbg_stack_0ed75d68575b0f3c(arg0, arg1) {
    const ret = arg1.stack;
    const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
    getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
};

export function __wbg_static_accessor_GLOBAL_88a902d13a557d07() {
    const ret = typeof global === 'undefined' ? null : global;
    return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
};

export function __wbg_static_accessor_GLOBAL_THIS_56578be7e9f832b0() {
    const ret = typeof globalThis === 'undefined' ? null : globalThis;
    return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
};

export function __wbg_static_accessor_SELF_37c5d418e4bf5819() {
    const ret = typeof self === 'undefined' ? null : self;
    return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
};

export function __wbg_static_accessor_WINDOW_5de37043a91a9c40() {
    const ret = typeof window === 'undefined' ? null : window;
    return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
};

export function __wbg_subarray_aa9065fa9dc5df96(arg0, arg1, arg2) {
    const ret = arg0.subarray(arg1 >>> 0, arg2 >>> 0);
    return ret;
};

export function __wbg_versions_c01dfd4722a88165(arg0) {
    const ret = arg0.versions;
    return ret;
};

export function __wbindgen_debug_string(arg0, arg1) {
    const ret = debugString(arg1);
    const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
    getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
};

export function __wbindgen_error_new(arg0, arg1) {
    const ret = new Error(getStringFromWasm0(arg0, arg1));
    return ret;
};

export function __wbindgen_init_externref_table() {
    const table = wasm.__wbindgen_export_2;
    const offset = table.grow(4);
    table.set(0, undefined);
    table.set(offset + 0, undefined);
    table.set(offset + 1, null);
    table.set(offset + 2, true);
    table.set(offset + 3, false);
    ;
};

export function __wbindgen_is_function(arg0) {
    const ret = typeof(arg0) === 'function';
    return ret;
};

export function __wbindgen_is_object(arg0) {
    const val = arg0;
    const ret = typeof(val) === 'object' && val !== null;
    return ret;
};

export function __wbindgen_is_string(arg0) {
    const ret = typeof(arg0) === 'string';
    return ret;
};

export function __wbindgen_is_undefined(arg0) {
    const ret = arg0 === undefined;
    return ret;
};

export function __wbindgen_memory() {
    const ret = wasm.memory;
    return ret;
};

export function __wbindgen_string_new(arg0, arg1) {
    const ret = getStringFromWasm0(arg0, arg1);
    return ret;
};

export function __wbindgen_throw(arg0, arg1) {
    throw new Error(getStringFromWasm0(arg0, arg1));
};

