// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title BrainVault
/// @notice Permission and audit ledger for encrypted neural-data sessions.
/// The data itself never comes on chain: an owner encrypts a recording off
/// chain and stores only its fingerprint (a hash of the ciphertext) here.
/// The owner grants or revokes read access per app, and every read attempt,
/// allowed or denied, is recorded as an event.
///
/// This contract decides and records who may read. It cannot stop someone
/// who already holds a decryption key: releasing keys only to apps this
/// contract allows is the job of the off-chain key holder.
contract BrainVault {
    struct Session {
        bytes32 fingerprint; // hash of the encrypted recording
        uint64 storedAt; // block timestamp
    }

    mapping(address owner => Session[]) private _sessions;
    mapping(address owner => mapping(address app => bool)) public canRead;

    event SessionStored(address indexed owner, uint256 indexed sessionId, bytes32 fingerprint);
    event AccessGranted(address indexed owner, address indexed app);
    event AccessRevoked(address indexed owner, address indexed app);
    event ReadAllowed(address indexed owner, address indexed app, uint256 indexed sessionId);
    event ReadDenied(address indexed owner, address indexed app, uint256 indexed sessionId);

    error ZeroFingerprint();
    error ZeroAddress();
    error NoSuchSession();

    /// @notice Record the fingerprint of a new encrypted session for the caller.
    function storeSession(bytes32 fingerprint) external returns (uint256 sessionId) {
        if (fingerprint == bytes32(0)) revert ZeroFingerprint();
        sessionId = _sessions[msg.sender].length;
        _sessions[msg.sender].push(Session(fingerprint, uint64(block.timestamp)));
        emit SessionStored(msg.sender, sessionId, fingerprint);
    }

    /// @notice Let `app` read the caller's sessions.
    function grant(address app) external {
        if (app == address(0)) revert ZeroAddress();
        canRead[msg.sender][app] = true;
        emit AccessGranted(msg.sender, app);
    }

    /// @notice Stop `app` from reading the caller's sessions.
    function revoke(address app) external {
        canRead[msg.sender][app] = false;
        emit AccessRevoked(msg.sender, app);
    }

    /// @notice Called by an app that wants to read one of `owner`'s sessions.
    /// Never reverts on a missing permission, so that a denied attempt is
    /// still recorded on chain.
    function requestRead(address owner, uint256 sessionId) external returns (bool allowed) {
        if (sessionId >= _sessions[owner].length) revert NoSuchSession();
        allowed = msg.sender == owner || canRead[owner][msg.sender];
        if (allowed) emit ReadAllowed(owner, msg.sender, sessionId);
        else emit ReadDenied(owner, msg.sender, sessionId);
    }

    function sessionCount(address owner) external view returns (uint256) {
        return _sessions[owner].length;
    }

    function session(address owner, uint256 sessionId) external view returns (bytes32 fingerprint, uint64 storedAt) {
        if (sessionId >= _sessions[owner].length) revert NoSuchSession();
        Session storage s = _sessions[owner][sessionId];
        return (s.fingerprint, s.storedAt);
    }
}
